import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { WebContents } from 'electron'
import { IpcChannels } from '../../shared/ipc'
import type { HostKeyDecision, SessionStatus, SshSessionConfig, TermSize } from '../../shared/types'
import type { KnownHostsStore } from '../store/knownHosts'
import { createChunkBatcher } from '../chunkBatcher'
import { execCapture } from './remoteExec'
import { parseProcNetTcp, procListenCommand } from './procNet'

interface ActiveSession {
  id: string
  /** 断开重连期间为 null；换连接时整体替换 */
  client: Client | null
  shell: ClientChannel | null
  sftpClient: SFTPWrapper | null
  /** 跳板机连接链（目标会话存活期间必须保持） */
  jumps: Client[]
  owner: WebContents
  /** 最后一次已知的终端尺寸：重连时用它开新 shell，否则会退回 80x24 */
  term: TermSize
  /** 已保存设备才有：重连时凭它重新解密凭证，不必在主进程常驻明文密码 */
  savedSessionId?: string
  /** 仅临时连接（未保存）需要暂存；会话被销毁时必须随对象一起释放 */
  config?: SshSessionConfig
  /** 用户主动断开 / 应用退出 —— 之后不再重连 */
  disposed: boolean
  /** 用户点了「停止」，或重连遇到不可恢复的错误 */
  stopped: boolean
  /** 已尝试的重连次数，成功后归零 */
  attempt: number
  timer: NodeJS.Timeout | null
  /**
   * 最近一次连接级错误的原文。
   * 'close' 事件本身不带原因，想给用户一个像样的断线说明就得靠 'error' 先记下来。
   */
  lastError?: string
}

/** 由已保存会话 id 解析出完整连接配置（含解密后的认证信息）。跳板机与断线重连共用。 */
export type SavedSessionResolver = (id: string) => SshSessionConfig

const MAX_JUMP_DEPTH = 3
/** 指纹确认弹窗的最长等待时间：超时按拒绝处理，避免挂起的连接与待决记录泄漏 */
const HOST_KEY_TIMEOUT_MS = 120_000
/** shell 通道建立的整体超时（readyTimeout 覆盖不到 shell 阶段） */
const SHELL_TIMEOUT_MS = 30_000
/** 重连退避：1→2→4→8→16→30s 封顶 */
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

/** 重试不会改变结果的错误（本地配置问题）——不要拿它去撞服务器 */
class FatalConnectError extends Error {}

/** 网络类错误的 errno，命中即认为「值得重连」 */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN'
])

function backoffMs(attempt: number): number {
  // 用 min 卡住指数，避免大 attempt 时 2**n 溢出成 Infinity
  return Math.min(RECONNECT_BASE_MS * 2 ** Math.min(attempt - 1, 10), RECONNECT_MAX_MS)
}

type FailureKind = 'retryable' | 'auth' | 'hostkey' | 'fatal'

/**
 * 判断一次连接失败该不该重试。
 *
 * 底线：**认证失败绝不重试**。反复用错误的密码撞服务器会触发 fail2ban /
 * 账户锁定，把「重连功能」变成「封号功能」。指纹失败同理（用户已经拒绝过）。
 *
 * 认不出来的错误一律归为可重连：网络中断的报错文案千奇百怪，漏判的代价是
 * 「永远不重连」，用户要的功能直接失效。真正危险的类别已在上面单独拦掉。
 */
function classifyFailure(err: unknown): FailureKind {
  if (err instanceof FatalConnectError) return 'fatal'

  const e = err as { level?: string; code?: string; message?: string }
  const msg = e.message ?? String(err)

  // ssh2 用 level 区分阶段：认证失败是 'client-authentication'
  if (e.level === 'client-authentication') return 'auth'
  if (/all configured authentication methods failed|authentication failure|permission denied/i.test(msg)) {
    return 'auth'
  }
  if (/host verification failed|host key verification/i.test(msg)) return 'hostkey'

  if (e.level === 'client-socket' || e.level === 'client-dns' || e.level === 'client-timeout') {
    return 'retryable'
  }
  if (e.code && NETWORK_CODES.has(e.code)) return 'retryable'
  if (/timed out|keepalive|connection lost|socket hang up|连接超时/i.test(msg)) return 'retryable'

  return 'retryable'
}

const NAVIGATION_ERROR: Record<FailureKind, string> = {
  auth: '认证失败，已停止重连（重复尝试错误密码会导致账户被锁定）',
  hostkey: '主机密钥未被信任，已停止重连',
  fatal: '重连配置有误，已停止',
  retryable: ''
}

/**
 * SSH 会话池：所有 ssh2 Client 由主进程持有，
 * 渲染进程刷新 / 切换页面都不会断连，密钥也永不出主进程。
 *
 * 会话 id 在整条生命周期内**保持稳定**（重连不重新分配）：渲染进程的
 * TerminalPanel 在挂载时就把 sessionId 捕获进各个闭包，换 id 会让输出被
 * 静默丢弃、输入打到已死的连接上。稳定 id 让重连对渲染进程几乎透明。
 */
export class SessionManager {
  private sessions = new Map<string, ActiveSession>()
  /** requestId → 等待用户决策的 hostVerifier Promise resolve */
  private pendingVerify = new Map<string, (decision: HostKeyDecision) => void>()

  constructor(
    private readonly resolveSavedSession?: SavedSessionResolver,
    private readonly knownHosts?: KnownHostsStore
  ) {}

  /**
   * 建立连接并打开交互式 shell，返回会话 id（失败抛错）。
   * 传入 savedSessionId 时不会常驻明文凭证 —— 重连时按 id 重新解密。
   */
  async connect(
    config: SshSessionConfig,
    owner: WebContents,
    term: TermSize,
    opts?: { savedSessionId?: string }
  ): Promise<string> {
    const id = randomUUID()
    const { client, shell, jumps } = await this.openShell(config, owner, term)

    const session: ActiveSession = {
      id,
      client,
      shell,
      sftpClient: null,
      jumps,
      owner,
      term,
      savedSessionId: opts?.savedSessionId,
      config: opts?.savedSessionId ? undefined : config,
      disposed: false,
      stopped: false,
      attempt: 0,
      timer: null
    }
    this.sessions.set(id, session)
    this.wireSession(session, client, shell)
    this.notifyStatus(session, 'connected')
    /*
     * 后台预热 sftp 通道：面板首次列目录少一次通道往返。
     * 失败静默 —— sftp() 在首次真实调用时照旧重试，预热只是顺手。
     */
    void this.sftp(id).catch(() => undefined)
    return id
  }

  /** 键盘输入 → 远端 shell */
  write(id: string, data: string | Uint8Array): void {
    this.sessions.get(id)?.shell?.write(data)
  }

  /** 终端行列变化必须同步给远端，否则 vim / top 等全屏程序会错乱 */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    // 记住尺寸：重连时要按它开新 shell
    session.term = { cols, rows }
    session.shell?.setWindow(rows, cols, 0, 0)
  }

  disconnect(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.disposed = true
    this.clearTimer(session)
    // 先出表：client.end() 触发的 'close' 走 handleClosed 时会查不到而直接返回，
    // 这正是我们想要的 —— 主动断开不产生任何重连
    this.sessions.delete(id)
    session.client?.end()
    this.finalize(session)
  }

  /** 应用退出前清理全部连接 */
  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }

  /**
   * 重连控制（渲染进程的「停止」/「立即重试」按钮）。
   * stop：停在这里，会话留在表里以便界面展示与手动恢复
   * now ：清掉退避立刻再来一轮
   */
  reconnectControl(id: string, action: 'stop' | 'now'): void {
    const session = this.sessions.get(id)
    if (!session || session.disposed) return

    if (action === 'stop') {
      this.clearTimer(session)
      session.stopped = true
      this.notifyStatus(session, 'closed', '已停止重连')
      return
    }

    this.clearTimer(session)
    session.stopped = false
    session.attempt = 0
    if (!this.hasCredentials(session)) {
      this.notifyStatus(session, 'error', '该会话未保存凭证，无法自动重连')
      session.stopped = true
      return
    }
    this.scheduleReconnect(session, '手动重试')
  }

  /**
   * 系统从休眠恢复：断了的连接不必再等满退避。
   * 注意这里只加速「已经在重连」的会话 —— ssh2 没有暴露存活探测，
   * 尚未被检测到已死的连接仍由 keepalive 超时（约 30s）发现。
   */
  resumeAfterSuspend(): void {
    for (const session of this.sessions.values()) {
      if (session.disposed || session.stopped || !session.timer) continue
      this.clearTimer(session)
      session.attempt = 0
      this.scheduleReconnect(session, '系统从休眠恢复')
    }
  }

  /** 暴露底层 ssh2 Client（端口转发等高级功能使用） */
  getClient(id: string): Client | undefined {
    return this.sessions.get(id)?.client ?? undefined
  }

  /** 会话结束回调（ForwardManager 借此停止关联规则）；每次断开都会触发 */
  onClosed: ((id: string) => void) | null = null

  /** 重连成功回调（ForwardManager 借此把转发规则重新建立起来） */
  onReconnected: ((id: string) => void) | null = null

  /**
   * 获取（或按需建立）该会话的 SFTP 通道。
   * SFTP 与 shell 复用同一条 SSH 连接，不额外握手。
   * 断线期间底层连接为空，这里必须显式拒绝而不是抛空指针。
   */
  async sftp(id: string): Promise<SFTPWrapper> {
    const session = this.sessions.get(id)
    if (!session?.client) throw new Error('会话不存在或已断开')
    if (session.sftpClient) return session.sftpClient
    const client = session.client
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err)
        // 等待期间可能又断线重连了，此时旧通道已失效，丢弃
        if (session.client !== client) return reject(new Error('会话已重新连接，请重试'))
        session.sftpClient = sftp
        resolve(sftp)
      })
    })
  }

  // ---- 内部实现 ----

  /** /proc 监听发现的短 TTL 缓存：同一秒内的重复轮询（多面板/分屏）只跑一次命令 */
  private listenerCache = new Map<string, { at: number; ports: number[] }>()
  /** 读不了 /proc（非 Linux）的会话：记一次就不再反复跑必然失败的命令 */
  private listenerUnsupported = new Set<string>()

  /**
   * 远端 LISTEN 端口列表（读 /proc/net/tcp{,6}，VS Code "process" 检测源的无 agent 版）。
   *
   * supported=false 表示这台远端没有 /proc（非 Linux）或通道异常 ——
   * 调用方据此停掉轮询，而不是每几秒跑一次必然失败的命令。
   */
  async remoteListeners(id: string): Promise<{ ports: number[]; supported: boolean }> {
    if (this.listenerUnsupported.has(id)) return { ports: [], supported: false }
    const cached = this.listenerCache.get(id)
    if (cached && Date.now() - cached.at < 3000) {
      return { ports: cached.ports, supported: true }
    }
    const client = this.getClient(id)
    if (!client) return { ports: [], supported: false }
    try {
      const res = await execCapture(client, procListenCommand(), { timeoutMs: 8000 })
      const ports = parseProcNetTcp(res.stdout)
      this.listenerCache.set(id, { at: Date.now(), ports })
      return { ports, supported: true }
    } catch {
      this.listenerUnsupported.add(id)
      return { ports: [], supported: false }
    }
  }

  /**
   * 建立一条完整的 SSH 连接（含跳板机链）并打开 shell。
   * connect 与断线重连共用这一条路径。
   */
  private async openShell(
    config: SshSessionConfig,
    owner: WebContents,
    term: TermSize
  ): Promise<{ client: Client; shell: ClientChannel; jumps: Client[] }> {
    const client = new Client()
    const { cfg: connectConfig, jumps } = await this.buildConnectConfig(config, 0, owner)

    const cleanupJumps = (): void => {
      for (const jump of jumps) jump.end()
    }

    return new Promise((resolve, reject) => {
      let settled = false
      // shell 通道可能一直不响应（远端 MaxSessions 打满等），readyTimeout 覆盖不到，
      // 这里加整体超时，避免 UI 永远停在「正在连接」
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanupJumps()
        client.end()
        reject(new Error('连接超时：SSH 已建立但未能在 30 秒内打开 shell 通道'))
      }, SHELL_TIMEOUT_MS)

      client.on('ready', () => {
        client.shell(
          { term: 'xterm-256color', cols: term.cols, rows: term.rows },
          (err, stream) => {
            if (err) {
              clearTimeout(timer)
              client.end()
              cleanupJumps()
              if (!settled) {
                settled = true
                reject(err)
              }
              return
            }
            clearTimeout(timer)
            settled = true
            resolve({ client, shell: stream, jumps })
          }
        )
      })

      // 必须持久监听：settle 之后到 wireSession 接管之前，
      // 以及会话中途的 error，都需要有监听者，否则 Node 会直接抛出打崩主进程
      client.on('error', (err: Error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          cleanupJumps()
          reject(err)
        }
      })

      client.connect(connectConfig)
    })
  }

  /**
   * 把一条已建立的连接接到会话上。
   * 断开重连时会用新的 client/shell 再调一次，因此所有监听都必须重新挂。
   */
  private wireSession(session: ActiveSession, client: Client, shell: ClientChannel): void {
    const { id, owner } = session
    // 远端进程自己退出时 ssh2 会发 'exit'；连接被掐断时不会有这个事件。
    // 这是区分「用户敲了 exit」和「网络断了」的唯一可靠依据。
    const ctx = { shellExited: false }

    // 输出合并：刷屏时一条网络包一条 IPC 会烧穿主进程（见 chunkBatcher）。
    // stdout/stderr 共用同一个 batcher —— 两条流本就发同一通道，
    // 事件循环的到达顺序就是合并后的字节顺序。
    const batcher = createChunkBatcher((data) => {
      if (!owner.isDestroyed()) owner.send(IpcChannels.sshData, id, data)
    })
    shell.on('data', (chunk: Buffer) => batcher.push(chunk))
    shell.stderr.on('data', (chunk: Buffer) => batcher.push(chunk))
    shell.on('exit', () => {
      ctx.shellExited = true
    })
    shell.on('close', () => {
      // close 前必须落盘：否则通道最后几毫秒的输出会跟着定时器进坟墓
      batcher.flush()
      batcher.dispose()
      this.handleClosed(id, client, ctx.shellExited)
    })

    client.on('error', (err: Error) => {
      // 会话中途出错：'close' 随后会到，统一由 handleClosed 收尾。
      // 先记下原文，好让断线提示能说清原因（'close' 自己不带原因）
      const current = this.sessions.get(id)
      if (current?.client === client) {
        current.lastError = err.message
        console.warn(`[ssh] 会话出错: ${err.message}`)
      }
    })
    client.on('close', () => this.handleClosed(id, client, ctx.shellExited))
  }

  /**
   * client 'close' 与 shell channel 'close' 的统一收口点。
   *
   * source 用于识别迟到的旧连接事件：重连成功后再收到旧连接的 close，
   * 绝不能当成「又断了」——那样会陷入无限重连。
   */
  private handleClosed(id: string, source?: Client, shellExited = false): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (source && session.client && session.client !== source) return

    session.client = null
    session.shell = null
    session.sftpClient = null
    // 监听发现缓存随连接失效：重连后用新连接重新读，别让旧数据污染差分
    this.listenerCache.delete(id)
    this.finalize(session)

    if (session.disposed) {
      this.sessions.delete(id)
      this.notifyStatus(session, 'closed')
      return
    }

    if (shellExited) {
      // 用户自己敲了 exit —— 会话是他主动结束的。
      // 这里若也去重连，用户就永远退不出这个终端了。
      this.sessions.delete(id)
      this.notifyStatus(session, 'closed')
      return
    }

    // 有真实错误就报真实原因，否则给一句中性的
    const reason = session.lastError || '网络中断'

    if (session.stopped || !this.hasCredentials(session)) {
      // 留在 sessions 表里：界面还要展示这个标签，用户也可能手动恢复
      this.notifyStatus(session, 'closed', reason)
      return
    }

    this.scheduleReconnect(session, reason)
  }

  private hasCredentials(session: ActiveSession): boolean {
    return !!(session.savedSessionId || session.config)
  }

  private credentialsFor(session: ActiveSession): SshSessionConfig {
    if (session.savedSessionId) {
      if (!this.resolveSavedSession) throw new FatalConnectError('当前环境无法解析已保存的会话')
      // 每次重连都重新解密：用户改了密码能立刻用上，也不必常驻明文
      return this.resolveSavedSession(session.savedSessionId)
    }
    if (session.config) return session.config
    throw new FatalConnectError('该会话未保存凭证，无法自动重连')
  }

  private scheduleReconnect(session: ActiveSession, reason: string): void {
    if (session.disposed || session.stopped || session.timer) return
    if (!this.hasCredentials(session)) return

    session.attempt += 1
    const delayMs = backoffMs(session.attempt)
    this.notifyStatus(session, 'reconnecting', reason, { attempt: session.attempt, delayMs })

    session.timer = setTimeout(() => {
      session.timer = null
      void this.attemptReconnect(session)
    }, delayMs)
    session.timer.unref?.()
  }

  private async attemptReconnect(session: ActiveSession): Promise<void> {
    if (session.disposed || session.stopped) return

    let config: SshSessionConfig
    try {
      config = this.credentialsFor(session)
    } catch (err) {
      this.giveUp(session, err instanceof Error ? err.message : String(err))
      return
    }

    try {
      const { client, shell, jumps } = await this.openShell(config, session.owner, session.term)

      // 重连期间用户关掉了标签：新连接已经没人认领，立刻拆掉
      if (session.disposed) {
        client.end()
        for (const jump of jumps) jump.end()
        return
      }

      session.client = client
      session.shell = shell
      session.jumps = jumps
      // 旧 SFTP 通道已随旧连接失效，置空让下次 sftp() 惰性重建
      session.sftpClient = null
      session.attempt = 0
      session.lastError = undefined
      this.wireSession(session, client, shell)

      this.notifyStatus(session, 'connected', undefined, { reconnected: true })
      this.onReconnected?.(session.id)
      // 同 connect：后台预热 sftp 通道，重连后的首次列目录少一次往返
      void this.sftp(session.id).catch(() => undefined)
    } catch (err) {
      const kind = classifyFailure(err)
      if (kind !== 'retryable') {
        this.giveUp(session, NAVIGATION_ERROR[kind] || (err as Error).message)
        return
      }
      this.scheduleReconnect(session, (err as Error).message || '重连失败')
    }
  }

  /** 停止重连并把原因告诉用户；会话记录保留，界面仍能看到这个标签 */
  private giveUp(session: ActiveSession, error: string): void {
    this.clearTimer(session)
    session.stopped = true
    this.notifyStatus(session, 'error', error)
  }

  private clearTimer(session: ActiveSession): void {
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
  }

  /**
   * 会话收尾：关闭跳板机连接链并通知外部。
   * 掉线（'close' 事件）与主动 disconnect 都必须走这里 —— 跳板机的
   * forwardOut 通道会随 client.end() 关闭，但跳板机那条已认证的 SSH
   * 会话本身不会，必须显式 end，否则每次掉线都泄漏一个跳板机登录。
   */
  private finalize(session: ActiveSession): void {
    for (const jump of session.jumps) jump.end()
    session.jumps = []
    this.onClosed?.(session.id)
  }

  /**
   * known_hosts 校验（hostVerifier 回调）：
   * 指纹匹配直接放行；首次连接 / 指纹变更则挂起连接，弹窗等用户决策。
   * 无指纹库或无窗口时降级为放行并打印日志（保持可连接性）。
   */
  private async verifyHostKey(
    host: string,
    port: number,
    hash: string,
    owner?: WebContents
  ): Promise<boolean> {
    if (!this.knownHosts || !owner || owner.isDestroyed()) {
      console.info(`[ssh] ${host}:${port} host key fingerprint (sha256): ${hash}（未校验）`)
      return true
    }

    const stored = this.knownHosts.get(host, port)
    if (stored === hash) return true

    const status: 'new' | 'changed' = stored ? 'changed' : 'new'
    const requestId = randomUUID()

    return new Promise<boolean>((resolve) => {
      // 用户一直不回答（关窗、关标签、走开）时这条记录会永远留在表里，
      // 连接也永远挂起。超时后按拒绝处理，既回收记录也让连接有个了断。
      const timer = setTimeout(() => {
        if (this.pendingVerify.delete(requestId)) resolve(false)
      }, HOST_KEY_TIMEOUT_MS)
      timer.unref?.()

      this.pendingVerify.set(requestId, (decision) => {
        clearTimeout(timer)
        // 用户选择「信任并保存」或变更后「仍然信任」都更新指纹库
        if (decision === 'trust') this.knownHosts!.set(host, port, hash)
        resolve(decision !== 'reject')
      })
      owner.send(IpcChannels.sshHostKeyVerify, {
        requestId,
        host,
        port,
        fingerprint: `SHA256:${hash}`,
        storedFingerprint: stored ? `SHA256:${stored}` : undefined,
        status
      })
    })
  }

  /** 渲染进程回答指纹确认（ssh:hostKeyAnswer） */
  answerHostKey(requestId: string, decision: HostKeyDecision): void {
    const pending = this.pendingVerify.get(requestId)
    if (!pending) return
    this.pendingVerify.delete(requestId)
    pending(decision)
  }

  private notifyStatus(
    session: ActiveSession,
    status: SessionStatus,
    error?: string,
    extra?: { attempt?: number; delayMs?: number; reconnected?: boolean }
  ): void {
    if (session.owner.isDestroyed()) return
    session.owner.send(IpcChannels.sshStatus, { id: session.id, status, error, ...extra })
  }

  /**
   * 构建 ssh2 连接配置；若配置了跳板机，先递归建立跳板连接链，
   * 再用 forwardOut 打通到目标的 TCP 通道作为 sock（等效 ssh -J / ProxyJump）。
   */
  private async buildConnectConfig(
    config: SshSessionConfig,
    depth = 0,
    owner?: WebContents
  ): Promise<{ cfg: ConnectConfig; jumps: Client[] }> {
    const base = await this.buildAuthConfig(config, owner)

    if (!config.jumpHostId) return { cfg: base, jumps: [] }
    if (depth >= MAX_JUMP_DEPTH) {
      throw new FatalConnectError(`跳板机层级超过 ${MAX_JUMP_DEPTH} 层，已中止`)
    }
    if (!this.resolveSavedSession) throw new FatalConnectError('当前环境不支持跳板机')

    // 1. 递归建立跳板连接（jumpHostId 指向的会话自身也可以再挂跳板）
    const jumpConfig = this.resolveSavedSession(config.jumpHostId)
    const jump = new Client()
    const { cfg: jumpCfg, jumps: upstreamJumps } = await this.buildConnectConfig(
      jumpConfig,
      depth + 1,
      owner
    )
    try {
      await new Promise<void>((resolve, reject) => {
        let connected = false
        // 必须用持久监听：once('error') 在首次 error 后就被移除，而跳板机是
        // 长连接（keepalive 超时、网络抖动都会 emit error），第二次 error 时
        // 无监听者，Node 会直接抛出并让整个主进程崩溃
        jump.on('error', (err: Error) => {
          if (!connected) {
            connected = true
            reject(err)
          } else {
            console.warn(`[ssh] 跳板机连接异常: ${err.message}`)
          }
        })
        jump.once('ready', () => {
          connected = true
          resolve()
        })
        jump.connect(jumpCfg)
      })

      // 2. 在跳板内部打通到目标主机的通道
      const sock = await new Promise<ClientChannel>((resolve, reject) => {
        jump.forwardOut('127.0.0.1', 0, config.host, config.port, (err, stream) =>
          err ? reject(err) : resolve(stream)
        )
      })
      return { cfg: { ...base, sock }, jumps: [jump, ...upstreamJumps] }
    } catch (err) {
      jump.end()
      for (const upstream of upstreamJumps) upstream.end()
      throw err
    }
  }

  private async buildAuthConfig(config: SshSessionConfig, owner?: WebContents): Promise<ConnectConfig> {
    const base: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      // 指纹确认弹窗需要等用户操作，给足时间
      readyTimeout: 60_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      // 双参形式为异步校验：连接挂起直到 verify() 被调用（用户决策后）
      hostVerifier: (hash: string, verify: (ok: boolean) => void) => {
        void this.verifyHostKey(config.host, config.port, hash, owner).then(verify)
        return true
      }
    }

    if (config.auth.type === 'password') {
      return { ...base, password: config.auth.password }
    }

    // OpenSSH 新格式与 PEM 均由 ssh2 直接支持；PuTTY 的 .ppk 需用户先转换
    let privateKey: Buffer
    try {
      privateKey = await readFile(config.auth.privateKeyPath)
    } catch {
      throw new FatalConnectError(`无法读取私钥文件：${config.auth.privateKeyPath}`)
    }
    return {
      ...base,
      privateKey,
      passphrase: config.auth.passphrase || undefined
    }
  }
}

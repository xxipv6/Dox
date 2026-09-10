import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { WebContents } from 'electron'
import { IpcChannels } from '../../shared/ipc'
import type { HostKeyDecision, SessionStatus, SshSessionConfig, TermSize } from '../../shared/types'
import type { KnownHostsStore } from '../store/knownHosts'

interface ActiveSession {
  id: string
  client: Client
  shell: ClientChannel | null
  sftpClient: SFTPWrapper | null
  /** 跳板机连接链（目标会话存活期间必须保持） */
  jumps: Client[]
  owner: WebContents
}

/** 由跳板机 id 解析出完整连接配置（含解密后的认证信息） */
export type JumpResolver = (id: string) => SshSessionConfig

const MAX_JUMP_DEPTH = 3

/**
 * SSH 会话池：所有 ssh2 Client 由主进程持有，
 * 渲染进程刷新 / 切换页面都不会断连，密钥也永不出主进程。
 */
export class SessionManager {
  private sessions = new Map<string, ActiveSession>()
  /** requestId → 等待用户决策的 hostVerifier Promise resolve */
  private pendingVerify = new Map<string, (decision: HostKeyDecision) => void>()

  constructor(
    private readonly resolveJump?: JumpResolver,
    private readonly knownHosts?: KnownHostsStore
  ) {}

  /** 建立连接并打开交互式 shell，返回会话 id（失败抛错） */
  async connect(config: SshSessionConfig, owner: WebContents, term: TermSize): Promise<string> {
    const id = randomUUID()
    const client = new Client()
    const { cfg: connectConfig, jumps } = await this.buildConnectConfig(config, 0, owner)

    const cleanupJumps = (): void => {
      for (const jump of jumps) jump.end()
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false

      client.on('ready', () => {
        client.shell(
          { term: 'xterm-256color', cols: term.cols, rows: term.rows },
          (err, stream) => {
            if (err) {
              client.end()
              cleanupJumps()
              if (!settled) {
                settled = true
                reject(err)
              }
              return
            }

            const session: ActiveSession = { id, client, shell: stream, sftpClient: null, jumps, owner }
            this.sessions.set(id, session)

            stream.on('data', (chunk: Buffer) => {
              if (!owner.isDestroyed()) owner.send(IpcChannels.sshData, id, chunk)
            })
            stream.stderr.on('data', (chunk: Buffer) => {
              if (!owner.isDestroyed()) owner.send(IpcChannels.sshData, id, chunk)
            })
            stream.on('close', () => this.handleClosed(id))

            this.notifyStatus(session, 'connected')
            settled = true
            resolve(id)
          }
        )
      })

      client.on('error', (err) => {
        const session = this.sessions.get(id)
        if (session) this.notifyStatus(session, 'error', err.message)
        if (!settled) {
          settled = true
          cleanupJumps()
          reject(err)
        }
      })

      client.on('close', () => this.handleClosed(id))

      client.connect(connectConfig)
    })
  }

  /** 键盘输入 → 远端 shell */
  write(id: string, data: string | Uint8Array): void {
    this.sessions.get(id)?.shell?.write(data)
  }

  /** 终端行列变化必须同步给远端，否则 vim / top 等全屏程序会错乱 */
  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.shell?.setWindow(rows, cols, 0, 0)
  }

  disconnect(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.client.end()
    for (const jump of session.jumps) jump.end()
    this.onClosed?.(id)
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
      this.pendingVerify.set(requestId, (decision) => {
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

  /** 应用退出前清理全部连接 */
  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }

  /** 暴露底层 ssh2 Client（端口转发等高级功能使用） */
  getClient(id: string): Client | undefined {
    return this.sessions.get(id)?.client
  }

  /** 会话结束回调（ForwardManager 借此停止关联规则）；disconnect / 远端断开都会触发且仅一次 */
  onClosed: ((id: string) => void) | null = null

  /**
   * 获取（或按需建立）该会话的 SFTP 通道。
   * SFTP 与 shell 复用同一条 SSH 连接，不额外握手。
   */
  async sftp(id: string): Promise<SFTPWrapper> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('会话不存在或已断开')
    if (session.sftpClient) return session.sftpClient
    return new Promise<SFTPWrapper>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) return reject(err)
        session.sftpClient = sftp
        resolve(sftp)
      })
    })
  }

  private handleClosed(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    this.notifyStatus(session, 'closed')
    this.onClosed?.(id)
  }

  private notifyStatus(session: ActiveSession, status: SessionStatus, error?: string): void {
    if (!session.owner.isDestroyed()) {
      session.owner.send(IpcChannels.sshStatus, { id: session.id, status, error })
    }
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
    if (depth >= MAX_JUMP_DEPTH) throw new Error(`跳板机层级超过 ${MAX_JUMP_DEPTH} 层，已中止`)
    if (!this.resolveJump) throw new Error('当前环境不支持跳板机')

    // 1. 递归建立跳板连接（jumpHostId 指向的会话自身也可以再挂跳板）
    const jumpConfig = this.resolveJump(config.jumpHostId)
    const jump = new Client()
    const { cfg: jumpCfg, jumps: upstreamJumps } = await this.buildConnectConfig(
      jumpConfig,
      depth + 1,
      owner
    )
    try {
      await new Promise<void>((resolve, reject) => {
        jump.once('ready', resolve)
        jump.once('error', reject)
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
    const privateKey = await readFile(config.auth.privateKeyPath)
    return {
      ...base,
      privateKey,
      passphrase: config.auth.passphrase || undefined
    }
  }
}

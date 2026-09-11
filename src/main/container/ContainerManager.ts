import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import os from 'node:os'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { Client, ClientChannel } from 'ssh2'
import type { WebContents } from 'electron'
import { IpcChannels } from '../../shared/ipc'
import {
  CONTAINER_ID_PREFIX,
  isLocalContainerTarget,
  LOCAL_CONTAINER_TARGET
} from '../../shared/sessionId'
import type { ContainerControlAction, ContainerInfo, ContainerProbeResult, TermSize } from '../../shared/types'
import { execCapture } from '../ssh/remoteExec'
import { parseProcNetTcp } from '../ssh/procNet'
import { CommandError, outputsOf } from '../execError'
import { createChunkBatcher } from '../chunkBatcher'
import { isNotFound, runLocal } from './localRun'
import {
  assertContainerTarget,
  classifyFailure,
  controlCommand,
  interactiveExecCommand,
  listCommand,
  localControlArgs,
  localInteractiveArgs,
  localListArgs,
  localLogsArgs,
  localShellProbeArgs,
  logsCommand,
  parseInspectIp,
  parseListing,
  parseRows,
  shellProbeCommand,
  SHELL_CANDIDATES,
  shouldDowngradeFormat
} from './runtime'

/**
 * 容器终端：容器里的一个 shell。
 *
 * **两种承载**：目标是一台 SSH 机器时，在**父 SSH 连接**上开一条 `docker exec`
 * 交互通道；目标是本机时，起一个 node-pty 跑 `docker exec -it`。上层完全一样 ——
 * 列表、错误分类、shell 解析、会话生命周期都共用，只有「怎么把字节送进去」不同。
 *
 * 为什么独立成一个 manager 而不是塞进 SessionManager：
 * 远端容器会话的 `client` 就是父会话那条连接。混在一起的话，
 * `disconnect()` 会 `client.end()` 掐断整条 SSH 连接（宿主机标签跟着死）、
 * `sftp()` 会返回宿主机的文件系统（界面以为在看容器）、
 * `handleClosed()` 会把它拖进指数退避重连。
 * 这三处任何一处漏判都是**不报错的错**，所以从结构上分开。
 *
 * 于是「容器不重连」这个性质来自**那段代码根本不存在**，而不是来自一个 guard。
 */

/** 一个 shell 靠什么活着 */
type Carrier =
  /** 远端：父 SSH 连接上的一条 exec 通道 */
  | { kind: 'ssh'; channel: ClientChannel }
  /** 本机：一个 node-pty 进程（跑的是 docker/podman exec -it） */
  | { kind: 'local'; pty: IPty }

interface ContainerSession {
  id: string
  /**
   * 真实 SSH 会话 id，或 `LOCAL_CONTAINER_TARGET`（本机）。**不会是别的值** ——
   * 本地会话的这个字段永远不会和 SessionManager 报上来的 id 相等，
   * 所以 SSH 断开时的 stopBySession 天然不会误伤它们。
   */
  parentSessionId: string
  containerName: string
  carrier: Carrier
  owner: WebContents
  term: TermSize
}

/** 每个目标探测到的 runtime 信息；正结果才缓存，避免「装完 docker 也探测不到」 */
interface RuntimeInfo {
  binary: string
  runtime: 'docker' | 'podman'
  legacy: boolean
}

export class ContainerManager {
  private sessions = new Map<string, ContainerSession>()
  private runtimeByParent = new Map<string, RuntimeInfo>()
  /** `${目标} ${容器名}` → 解析好的 shell。重复进入零成本 */
  private shellByTarget = new Map<string, string>()
  /**
   * 父会话 id → 骑在它上面的存活 exec 通道数（仅远端；本机通道没有父连接）。
   * SessionManager 据此决定关宿主标签时是否把连接留作孤儿保活。
   */
  private channelsByParent = new Map<string, number>()

  /**
   * 某父会话的最后一个容器通道关闭时触发（SessionManager 回收孤儿连接用）。
   * 只在 1→0 时发一次；通道反复开关不会重复触发。
   */
  onParentDrained: ((parentSessionId: string) => void) | null = null

  constructor(private readonly getClient: (sessionId: string) => Client | undefined) {}

  /** 该父会话下是否还有存活的容器 exec 通道（宿主标签关闭时的保活判据） */
  hasActiveChannels(parentSessionId: string): boolean {
    return (this.channelsByParent.get(parentSessionId) ?? 0) > 0
  }

  private track(session: ContainerSession): void {
    if (session.carrier.kind !== 'ssh') return
    const n = this.channelsByParent.get(session.parentSessionId) ?? 0
    this.channelsByParent.set(session.parentSessionId, n + 1)
  }

  /** 与 track 配对：每条容器会话在出表处必须恰好走一次 */
  private untrack(session: ContainerSession): void {
    if (session.carrier.kind !== 'ssh') return
    const n = (this.channelsByParent.get(session.parentSessionId) ?? 0) - 1
    if (n > 0) {
      this.channelsByParent.set(session.parentSessionId, n)
      return
    }
    this.channelsByParent.delete(session.parentSessionId)
    this.onParentDrained?.(session.parentSessionId)
  }

  /**
   * 探测并列出容器。**不抛错** —— 「没装 docker」「没权限」是预期内的状态，
   * 各自要有各自的界面，扔进 catch 就只剩一句没用的「失败了」。
   */
  async list(parentSessionId: string): Promise<ContainerProbeResult> {
    if (isLocalContainerTarget(parentSessionId)) return this.listLocal()

    const client = this.getClient(parentSessionId)
    if (!client) {
      return { ok: false, reason: 'error', message: '会话不存在或已断开' }
    }

    const cached = this.runtimeByParent.get(parentSessionId)
    const legacy = cached?.legacy ?? false

    try {
      const res = await execCapture(client, listCommand(legacy))
      return this.readListing(parentSessionId, res.stdout, legacy)
    } catch (err) {
      // 输出被截断不是失败：已经拿到的部分里就有 marker 行和开头一批容器
      if (err instanceof CommandError && err.failure === 'truncated') {
        const partial = this.readListing(parentSessionId, err.stdout, legacy)
        if (partial.ok) partial.list.truncated = true
        return partial
      }
      // docker 太老 / 模板字段不存在：降级成只有 ID/Names/Image 的格式再试一次
      if (!legacy && shouldDowngradeFormat(err)) {
        try {
          const res = await execCapture(client, listCommand(true))
          const downgraded = this.readListing(parentSessionId, res.stdout, true)
          if (downgraded.ok) downgraded.list.formatDowngraded = true
          return downgraded
        } catch (retryErr) {
          return { ok: false, ...classifyFailure(textOf(retryErr)) }
        }
      }
      return { ok: false, ...classifyFailure(textOf(err)) }
    }
  }

  /**
   * 本机容器。
   *
   * 与远端那份的结构差别：远端靠 `command -v` 在远端把二进制找出来回传，
   * 这里由 `execFile` 自己依次试 docker / podman —— ENOENT 就说明「这台机器
   * 没装」，换下一个。所以探测和「用哪个二进制」是同一次往返。
   */
  private async listLocal(): Promise<ContainerProbeResult> {
    const cached = this.runtimeByParent.get(LOCAL_CONTAINER_TARGET)
    const legacy = cached?.legacy ?? false
    // 已经探到过就直接用它，省掉一次必然失败的候选尝试
    const candidates = cached ? [cached.binary] : ['docker', 'podman']

    for (const binary of candidates) {
      try {
        const res = await runLocal(binary, localListArgs(legacy))
        return this.readLocalListing(binary, res.stdout, legacy)
      } catch (err) {
        // 这个二进制本机没有 → 试下一个；全都试完就是「没装」
        if (isNotFound(err)) continue

        if (!legacy && shouldDowngradeFormat(err)) {
          try {
            const res = await runLocal(binary, localListArgs(true))
            const downgraded = this.readLocalListing(binary, res.stdout, true)
            if (downgraded.ok) downgraded.list.formatDowngraded = true
            return downgraded
          } catch (retryErr) {
            return { ok: false, ...classifyFailure(textOf(retryErr)) }
          }
        }
        return { ok: false, ...classifyFailure(textOf(err)) }
      }
    }

    return {
      ok: false,
      reason: 'no-binary',
      message: '本机没有安装 docker 或 podman（装 Docker Desktop / Podman Desktop 即可）'
    }
  }

  /** 远端的列表：输出里带一行 marker，二进制路径从那儿来 */
  private readListing(
    parentSessionId: string,
    stdout: string,
    legacy: boolean
  ): ContainerProbeResult {
    let parsed
    try {
      parsed = parseListing(stdout, legacy)
    } catch (err) {
      return { ok: false, reason: 'error', message: textOf(err) }
    }
    if (!parsed.binary) {
      return { ok: false, reason: 'no-binary', message: '远端没有安装 docker 或 podman' }
    }
    return this.buildResult(
      parentSessionId,
      parsed.binary,
      parsed.containers,
      parsed.stoppedCount,
      legacy
    )
  }

  /** 本机的列表：二进制是我们自己选的，数据行直接解析 */
  private readLocalListing(
    binary: string,
    stdout: string,
    legacy: boolean
  ): ContainerProbeResult {
    const { containers, stoppedCount } = parseRows(stdout, legacy)
    return this.buildResult(LOCAL_CONTAINER_TARGET, binary, containers, stoppedCount, legacy)
  }

  private buildResult(
    target: string,
    binary: string,
    containers: ContainerInfo[],
    stoppedCount: number,
    legacy: boolean
  ): ContainerProbeResult {
    const runtime = /podman/.test(binary) ? 'podman' : 'docker'
    this.runtimeByParent.set(target, { binary, runtime, legacy })
    return { ok: true, list: { runtime, binary, containers, stoppedCount } }
  }

  /**
   * 进入容器，返回 `container-` 前缀的会话 id。
   *
   * 输入 / resize / 断开走既有的通用通道（按前缀路由），所以渲染层不需要新 API ——
   * 远端和本机共用同一个前缀，因为对上层来说它们都是「容器里的一个 shell」。
   */
  async open(
    parentSessionId: string,
    containerName: string,
    term: TermSize,
    owner: WebContents
  ): Promise<string> {
    // 容器名来自渲染进程，拼进任何命令前都要校验字符集（远端拼 shell 串，本机是 argv）
    assertContainerTarget(containerName)

    const runtime = this.runtimeByParent.get(parentSessionId)
    if (!runtime) {
      throw new Error('还没有探测到容器运行时，请先刷新容器列表')
    }

    const local = isLocalContainerTarget(parentSessionId)
    const carrier = local
      ? await this.openLocal(runtime.binary, containerName, term)
      : await this.openRemote(parentSessionId, runtime.binary, containerName, term)

    const id = `${CONTAINER_ID_PREFIX}${randomUUID()}`
    const session: ContainerSession = {
      id,
      parentSessionId,
      containerName,
      carrier,
      owner,
      term
    }
    this.sessions.set(id, session)
    this.track(session)
    this.wire(session)
    if (!owner.isDestroyed()) owner.send(IpcChannels.sshStatus, { id, status: 'connected' })
    return id
  }

  /**
   * 容器生命周期操作（start / stop / unpause / remove，白名单见 runtime.ts）。
   *
   * 这不是「远端零改动」的倒退：红线的本义是**不装 agent、不建文件、不留痕迹**，
   * 而这些是用户显式触发的 docker 子命令，跑完什么都不留下。
   * 动作只能经 CONTROL_VERBS 表换成动词，渲染层传过来的字符串永远不直接进命令。
   */
  async control(
    parentSessionId: string,
    containerName: string,
    action: ContainerControlAction
  ): Promise<void> {
    assertContainerTarget(containerName)

    const runtime = this.runtimeByParent.get(parentSessionId)
    if (!runtime) {
      throw new Error('还没有探测到容器运行时，请先刷新容器列表')
    }

    try {
      if (isLocalContainerTarget(parentSessionId)) {
        // stop 默认有 10s 优雅期，超时放宽到 15s
        await runLocal(runtime.binary, localControlArgs(containerName, action), { timeoutMs: 15000 })
      } else {
        const client = this.getClient(parentSessionId)
        if (!client) throw new Error('父会话已断开，请先恢复 SSH 连接')
        await execCapture(client, controlCommand(runtime.binary, containerName, action), {
          timeoutMs: 15000
        })
      }
    } catch (err) {
      const { stdout, stderr } = outputsOf(err)
      throw new Error(firstLine([stderr, stdout].filter(Boolean).join('\n')) || textOf(err))
    }

    // 容器状态变了（甚至删了重建），shell 缓存不再可信
    this.shellByTarget.delete(`${parentSessionId} ${containerName}`)
  }

  /**
   * 解析容器在 docker 网桥上的 IP（端口转发建议的目标地址）。
   *
   * 容器没发布端口时，远端 127.0.0.1 摸不到它，但宿主机能直连网桥 IP，
   * 把 SSH 转发目标指过去就通。只读 `inspect`，与只读探测同类。
   *
   * 返回 null 的两种情况各有各的回退：本机容器（Mac 到不了 VM 里的网桥，
   * 转发无意义）、host 网络或无 IP（回退 127.0.0.1 试试）。**不抛错** ——
   * 这只是个建议功能的辅助查询，挂了不该打断终端。
   */
  async containerIp(parentSessionId: string, containerName: string): Promise<string | null> {
    if (isLocalContainerTarget(parentSessionId)) return null
    const client = this.getClient(parentSessionId)
    if (!client) return null

    try {
      assertContainerTarget(containerName)
      // runtime 缓存只在 list 之后有；面板没开过就补一次探测（只读）
      if (!this.runtimeByParent.has(parentSessionId)) await this.list(parentSessionId)
      const runtime = this.runtimeByParent.get(parentSessionId)
      if (!runtime) return null

      const res = await execCapture(client, `${runtime.binary} inspect ${containerName}`, {
        timeoutMs: 10_000
      })
      return parseInspectIp(res.stdout)
    } catch {
      return null
    }
  }

  /** 该父会话上的容器 runtime 二进制名（AgentManager 拼 docker exec/cp 命令用） */
  async runtimeBinary(parentSessionId: string): Promise<string | null> {
    if (isLocalContainerTarget(parentSessionId)) return null
    if (!this.getClient(parentSessionId)) return null
    try {
      if (!this.runtimeByParent.has(parentSessionId)) await this.list(parentSessionId)
      return this.runtimeByParent.get(parentSessionId)?.binary ?? null
    } catch {
      return null
    }
  }

  /**
   * 容器里的 LISTEN 端口（容器标签转发建议的静默检测）。
   *
   * 容器有自己的 netns，宿主机那张 /proc/net/tcp 里看不到它的 socket，
   * 必须进容器读 —— docker exec 只读两张表，与只读探测同类。
   * 容器没 sh（distroless）/ 已停止 / 非 Linux 都归 supported=false，
   * 调用方据此停止轮询。**不抛错**，定位同 containerIp：辅助查询不该打断终端。
   */
  async containerListeners(
    parentSessionId: string,
    containerName: string
  ): Promise<{ ports: number[]; supported: boolean }> {
    const unsupported = { ports: [] as number[], supported: false }
    if (isLocalContainerTarget(parentSessionId)) return unsupported
    const client = this.getClient(parentSessionId)
    if (!client) return unsupported

    try {
      assertContainerTarget(containerName)
      if (!this.runtimeByParent.has(parentSessionId)) await this.list(parentSessionId)
      const runtime = this.runtimeByParent.get(parentSessionId)
      if (!runtime) return unsupported

      const res = await execCapture(
        client,
        `${runtime.binary} exec ${containerName} sh -c "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"`,
        { timeoutMs: 10_000 }
      )
      return { ports: parseProcNetTcp(res.stdout), supported: true }
    } catch {
      return unsupported
    }
  }

  /** 远端：父 SSH 连接上的 exec 通道 */
  private async openRemote(
    parentSessionId: string,
    binary: string,
    containerName: string,
    term: TermSize
  ): Promise<Carrier> {
    const client = this.getClient(parentSessionId)
    if (!client) {
      throw new Error('父会话已断开，请先恢复 SSH 连接后再进入容器')
    }

    const shell = await this.resolveShell(parentSessionId, binary, containerName, (candidate) =>
      execCapture(client, shellProbeCommand(binary, containerName, candidate), { timeoutMs: 8000 })
    )

    /*
     * 身份校验：探测那一次往返里父会话可能已经断线重连，手里这个 client 已经死了。
     * 不查的话会把 exec 通道挂到一个废弃的连接上 —— 表面上标签开出来了，
     * 实际永远收不到任何输出。（同 SessionManager.sftp 的写法。）
     */
    if (this.getClient(parentSessionId) !== client) {
      throw new Error('会话已重新连接，请重试')
    }

    const channel = await this.execChannel(
      client,
      interactiveExecCommand(binary, containerName, shell),
      term
    )
    return { kind: 'ssh', channel }
  }

  /** 本机：起一个 node-pty 跑 docker exec -it */
  private async openLocal(binary: string, containerName: string, term: TermSize): Promise<Carrier> {
    const shell = await this.resolveShell(LOCAL_CONTAINER_TARGET, binary, containerName, (c) =>
      runLocal(binary, localShellProbeArgs(containerName, c), { timeoutMs: 8000 })
    )

    const exe = await resolveExecutable(binary)
    const proc = pty.spawn(exe, localInteractiveArgs(containerName, shell), {
      name: 'xterm-256color',
      cols: term.cols,
      rows: term.rows,
      cwd: os.homedir(),
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' }
    })
    return { kind: 'local', pty: proc }
  }

  /**
   * 查看容器日志，返回 `container-` 前缀的会话 id（与 open() 同一种会话，
   * 输入/resize/断开/父会话断开联动全部复用，渲染层不需要第二套 API）。
   *
   * 与 open() 的差别：logs 是守护进程读日志驱动，**不依赖容器里有 shell**，
   * 所以跳过 resolveShell 预检 —— distroless 容器看得了日志但进不去终端。
   * 已停止的容器 docker logs 也合法（「它刚才为什么挂了」正是高频场景）。
   */
  async openLogs(
    parentSessionId: string,
    containerName: string,
    term: TermSize,
    owner: WebContents
  ): Promise<string> {
    assertContainerTarget(containerName)

    const runtime = this.runtimeByParent.get(parentSessionId)
    if (!runtime) {
      throw new Error('还没有探测到容器运行时，请先刷新容器列表')
    }

    let carrier: Carrier
    if (isLocalContainerTarget(parentSessionId)) {
      const exe = await resolveExecutable(runtime.binary)
      carrier = {
        kind: 'local',
        pty: pty.spawn(exe, localLogsArgs(containerName), {
          name: 'xterm-256color',
          cols: term.cols,
          rows: term.rows,
          cwd: os.homedir(),
          env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' }
        })
      }
    } else {
      const client = this.getClient(parentSessionId)
      if (!client) {
        throw new Error('父会话已断开，请先恢复 SSH 连接')
      }
      const channel = await this.execChannel(client, logsCommand(runtime.binary, containerName), term)
      // 与 openRemote 同款身份校验：开通道那一刻 client 必须还是快照里的那个
      if (this.getClient(parentSessionId) !== client) {
        try {
          channel.close()
        } catch {
          /* 已经关了 */
        }
        throw new Error('会话已重新连接，请重试')
      }
      carrier = { kind: 'ssh', channel }
    }

    const id = `${CONTAINER_ID_PREFIX}${randomUUID()}`
    const session: ContainerSession = {
      id,
      parentSessionId,
      containerName,
      carrier,
      owner,
      term
    }
    this.sessions.set(id, session)
    this.track(session)
    this.wire(session)
    if (!owner.isDestroyed()) owner.send(IpcChannels.sshStatus, { id, status: 'connected' })
    return id
  }

  /**
   * 容器里的 shell 是哪个（bash / sh / 都没有）。
   *
   * **这一步省不掉**：通道一旦打开就回不去了 —— 容器里没有 `sh` 时，exec 通道
   * 会正常打开、命令失败、错误落在流上、通道关闭，那时已经在解析一个「终端」
   * 而不是在返回错误。所以至少要一次往返。
   *
   * 但这一次探测顺带把三种失败**在开标签之前**区分开了：容器已停止、exec 被拒、
   * distroless 没有 shell。结果按 (目标, 容器名) 缓存，重复进入零成本。
   *
   * 探测动作本身由调用方给（远端是 exec 通道，本机是 execFile）—— 除了这一点，
   * 候选顺序、缓存、失败分类两条路完全一样。
   */
  private async resolveShell(
    target: string,
    binary: string,
    name: string,
    probe: (shell: string) => Promise<unknown>
  ): Promise<string> {
    const key = `${target} ${name}`
    const cached = this.shellByTarget.get(key)
    if (cached) return cached

    for (const shell of SHELL_CANDIDATES) {
      try {
        await probe(shell)
        this.shellByTarget.set(key, shell)
        return shell
      } catch (err) {
        const { stdout, stderr } = outputsOf(err)
        const { reason, message } = classifyFailure([stderr, stdout].filter(Boolean).join('\n'))
        // 只是这个 shell 不存在 → 试下一个；别的失败（容器停了 / 被拒）没有第二次机会
        if (reason === 'no-shell') continue
        throw new Error(message)
      }
    }
    throw new Error('容器内没有可用的 shell（可能是 distroless / scratch 镜像），这一期只支持终端')
  }

  private execChannel(client: Client, command: string, term: TermSize): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      try {
        client.exec(
          // 必须是 pty 对象：pty:true 等于 80×24，pty:false 会让 docker 报
          // 「the input device is not a TTY」且行编辑失效
          command,
          { pty: { term: 'xterm-256color', cols: term.cols, rows: term.rows } },
          (err, stream) => (err ? reject(err) : resolve(stream))
        )
      } catch (err) {
        // socket 已死时 ssh2 会同步抛 'Not connected'
        reject(err)
      }
    })
  }

  private wire(session: ContainerSession): void {
    if (session.carrier.kind === 'local') {
      this.wireLocal(session, session.carrier.pty)
      return
    }
    this.wireRemote(session, session.carrier.channel)
  }

  private wireRemote(session: ContainerSession, channel: ClientChannel): void {
    const { id, owner } = session
    let stdoutBytes = 0
    let startupStderr = ''
    let exitCode: number | null = null

    // 输出合并（见 chunkBatcher）；stdout/stderr 共用，顺序即事件循环到达顺序
    const batcher = createChunkBatcher((data) => {
      if (!owner.isDestroyed()) owner.send(IpcChannels.sshData, id, data)
    })
    channel.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      batcher.push(chunk)
    })
    // 正常跑起来时 `-t` 会把容器里的 stderr 并进 tty（这条流是空的）；
    // 只有 docker 自己在分配 tty 之前就报错（容器没在跑之类）才会走到这里
    channel.stderr?.on('data', (chunk: Buffer) => {
      if (startupStderr.length < 400) startupStderr += chunk.toString('utf8')
      batcher.push(chunk)
    })
    channel.on('exit', (code: number | null) => {
      exitCode = code
    })
    channel.on('close', () => {
      batcher.flush()
      batcher.dispose()
      this.handleClosed(id, channel, { stdoutBytes, startupStderr, exitCode })
    })
  }

  /**
   * 本机 pty 的接线。
   *
   * 判别式与远端那份**不同**，这不是遗漏：远端之所以能靠「stdout 一个字节都没有
   * 而 stderr 有内容」认出「docker exec 压根没跑起来」，是因为那边 stderr 是
   * 独立的一路流。pty 里两路是**合并**的 —— docker 的报错也会算进输出字节，
   * 那个判据在这里恒为 false，照搬只会得到「永远当作正常退出」。
   *
   * 本机不需要那个判据：进容器之前 `resolveShell` 已经用 execFile 真跑通过一次，
   * 容器在不在、有没有 shell 都已确认。真出现竞态（探测完到 spawn 之间容器被停），
   * docker 的报错原文会**直接打在终端里**给用户看，比我们猜一句话更准确。
   */
  private wireLocal(session: ContainerSession, proc: IPty): void {
    const { id, owner } = session

    const batcher = createChunkBatcher((data) => {
      if (!owner.isDestroyed()) owner.send(IpcChannels.sshData, id, data)
    })
    proc.onData((chunk) => {
      batcher.push(Buffer.from(chunk, 'utf8'))
    })
    proc.onExit(({ exitCode }) => {
      batcher.flush()
      batcher.dispose()
      const current = this.sessions.get(id)
      if (!current || current.carrier.kind !== 'local' || current.carrier.pty !== proc) return
      this.sessions.delete(id)
      this.untrack(current)
      // 这次失败多半是因为容器没了或镜像里没 shell，缓存不再可信
      this.shellByTarget.delete(`${session.parentSessionId} ${session.containerName}`)
      if (owner.isDestroyed()) return
      owner.send(IpcChannels.sshStatus, { id, status: 'closed', error: exitHint(exitCode) })
    })
  }

  /**
   * 远端通道关闭的统一收口。
   *
   * 正常 `exit` 退出容器 与 `docker exec` 压根没跑起来，都是通道关闭，必须分清 ——
   * 否则用户看到的就是「标签开了又没了，什么也没说」。
   *
   * 判据用「stdout 一个字节都没有 + stderr 有内容」而不是「用户有没有敲过键盘」：
   * 终端在启动阶段会自己回应一些查询序列，拿输入当信号会误判成「用户敲过了」。
   * docker CLI 自己的错误退出码是 125/126/127，一并作为佐证。
   */
  private handleClosed(
    id: string,
    channel: ClientChannel,
    info: { stdoutBytes: number; startupStderr: string; exitCode: number | null }
  ): void {
    const session = this.sessions.get(id)
    if (!session || session.carrier.kind !== 'ssh' || session.carrier.channel !== channel) return
    this.sessions.delete(id)
    this.untrack(session)

    const dockerError = [125, 126, 127].includes(info.exitCode ?? 0)
    const failedAtStart =
      info.stdoutBytes === 0 && (info.startupStderr.trim().length > 0 || dockerError)

    if (failedAtStart) {
      // 这次失败多半是因为容器没了或镜像里没 shell，缓存不再可信
      this.shellByTarget.delete(`${session.parentSessionId} ${session.containerName}`)
    }

    if (session.owner.isDestroyed()) return
    session.owner.send(IpcChannels.sshStatus, {
      id,
      status: 'closed',
      error: failedAtStart
        ? firstLine(info.startupStderr) || '进入容器失败（容器可能已停止）'
        : undefined
    })
  }

  write(id: string, data: string | Uint8Array): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.carrier.kind === 'ssh') {
      session.carrier.channel.write(data)
      return
    }
    // node-pty 只接受字符串（同 LocalPtyManager）
    try {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      session.carrier.pty.write(text)
    } catch {
      // 进程刚好退出时 write 会抛错，忽略
    }
  }

  /**
   * 终端行列变化。
   *
   * 远端：`setWindow` 对 exec 通道是合法的（ssh2 对 subtype === 'exec' 放行），
   * 而且必须调 —— sshd 把它变成 pty 上的 SIGWINCH，docker CLI 再调守护进程的
   * resize API 改容器控制台。不调的话容器里的 vim / top 永远卡在 80×24。
   * 本机：直接 resize 我们自己的 pty。
   */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.term = { cols, rows }

    if (session.carrier.kind === 'local') {
      try {
        session.carrier.pty.resize(cols, rows)
      } catch {
        // 进程刚好退出
      }
      return
    }
    try {
      session.carrier.channel.setWindow(rows, cols, 0, 0)
    } catch {
      // 通道刚好关了：尺寸记在 session.term 上即可，不值得打扰用户
    }
  }

  /** 用户关标签：只关这一个 shell，绝不碰父连接 */
  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    // 先出表：随后的 'close'/'exit' 事件查不到而直接返回，不会重复通知
    this.sessions.delete(id)
    this.untrack(session)
    if (session.carrier.kind === 'ssh') {
      try {
        session.carrier.channel.close()
      } catch {
        // 已经关了
      }
      return
    }
    killLocalPty(session.carrier.pty)
  }

  /**
   * 父 SSH 会话断了：把它承载的所有 exec 通道一并收掉。
   *
   * **必须在这里就把 `closed` 发出去。** 光删表 + 关通道是不够的：
   * 通道随后的 'close' 事件走到 handleClosed 时已经查不到这条记录，
   * 会直接 return —— 界面于是停在「已连接」，而终端其实早就死了。
   * 那是最糟的一种错：不报错，但显示的是假的。
   *
   * 顺带清掉 shell 缓存 —— 容器可能已经重建，镜像换了 shell 就未必还在。
   *
   * 本机会话不受影响：它们的 parentSessionId 是哨兵值，和任何真实会话 id 都不相等。
   */
  stopBySession(parentSessionId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.parentSessionId !== parentSessionId) continue
      if (session.carrier.kind === 'local') continue // 理论上到不了，防御一下
      this.sessions.delete(id)
      this.untrack(session)
      // 父连接断开是「正常结束」，不套用 failedAtStart 那套失败判定：
      // 这里没有 stderr 可看，乱猜一个错误原因比不说更糟
      if (!session.owner.isDestroyed()) {
        session.owner.send(IpcChannels.sshStatus, { id, status: 'closed' })
      }
      try {
        session.carrier.channel.close()
      } catch {
        // 已经关了
      }
    }
    for (const key of [...this.shellByTarget.keys()]) {
      if (key.startsWith(`${parentSessionId} `)) this.shellByTarget.delete(key)
    }
  }

  /** 应用退出 */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}

function textOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err ?? '')
}

function firstLine(text: string, max = 200): string {
  const line = (text || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * 本机 pty 退出时是否要带一句原因。
 *
 * docker CLI 自己的错误退出码是 125/126/127（命令没跑起来）。用户敲 `exit 3`
 * 也是 3，所以只能认这三个 —— 把任意非零码都当错误，会把「用户故意退出」
 * 说成「进入容器失败」。
 */
function exitHint(exitCode: number): string | undefined {
  if (exitCode === 0) return undefined
  if ([125, 126, 127].includes(exitCode)) return '进入容器失败（容器可能已停止）'
  return undefined
}

/**
 * 把命令名解析成绝对路径，供 node-pty 启动。
 *
 * ⚠️ **Windows 上必须挑带 `.exe` 的那个，不能取 `where` 的第一行。**
 * 实测踩到过：Docker Desktop 在 `resources\bin\` 里既放了 `docker.exe`，
 * 也放了一个**同样叫 `docker`、没有扩展名的 1359 字节 POSIX shell 脚本**
 * （内容是 `#!/usr/bin/env sh` + 一堆 case 分支）。而 `where docker` 把那个
 * 脚本排在 `.exe` 前面 —— 直接取第一行就等于把 sh 脚本交给 CreateProcess，
 * 报 `Cannot create process, error code: 193`（ERROR_BAD_EXE_FORMAT）。
 *
 * 只认 `.exe`：`.cmd`/`.bat` 同样不能直接被 CreateProcess 执行（要经 cmd.exe）。
 * 一个 `.exe` 都找不到就退回裸名字，让 CreateProcess 自己按 PATH 找 ——
 * 那是这一层存在之前的行为，不会比它更差。
 */
async function resolveExecutable(binary: string): Promise<string> {
  const cached = resolvedBinaryCache.get(binary)
  if (cached) return cached
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const found = await new Promise<string[]>((resolve) => {
    execFile(finder, [binary], { windowsHide: true }, (err, stdout) => {
      resolve(
        err
          ? []
          : stdout
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
      )
    })
  })

  let resolved: string
  if (!found.length) resolved = binary
  // POSIX 下 execvp 认 shebang 脚本，哪个在前就用哪个
  else if (process.platform !== 'win32') resolved = found[0]
  else resolved = found.find((p) => /\.exe$/i.test(p)) ?? binary
  resolvedBinaryCache.set(binary, resolved)
  return resolved
}

/*
 * 解析结果缓存：本机 PATH 在应用活着期间不会变，之前每次开容器终端
 * 都 spawn 一次 which/where 是白送的进程开销。不设上限 —— binary
 * 名字就 docker/podman 两个。
 */
const resolvedBinaryCache = new Map<string, string>()

/** 关掉本机 pty，并确保不留孤儿进程（同 LocalPtyManager 的 Windows 处理） */
function killLocalPty(proc: IPty): void {
  const pid = proc.pid
  try {
    proc.kill()
  } catch {
    // 已退出
  }
  // node-pty 在 Windows 上依赖 conpty_console_list_agent 枚举子进程，
  // 而该 agent 从终端启动时可能崩溃（AttachConsole failed），导致子进程残留。
  // 这里补一刀按进程树清理，确保不留孤儿容器 shell。
  if (process.platform === 'win32' && pid) {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => undefined)
  }
}

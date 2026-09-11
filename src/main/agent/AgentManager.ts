import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { app, type WebContents } from 'electron'
import type { ClientChannel } from 'ssh2'
import type { SessionManager } from '../ssh/SessionManager'
import { execCapture } from '../ssh/remoteExec'
import { mkdirRemoteRecursive } from '../sftp/sftpUtils'
import { assertContainerTarget, parseDockerInfoPlatform } from '../container/runtime'
import { IpcChannels } from '../../shared/ipc'

const REMOTE_BIN = '.dox/dox-agent'
/** 容器内的落点：/tmp 必然存在且可写（对照 vscode-server 的 /root/.vscode-server） */
const CTR_BIN = '/tmp/dox-agent'

/** uname -m → GOARCH（遇到新架构时在这里加，而不是让正则猜） */
const ARCH_MAP: Record<string, string> = {
  x86_64: 'amd64',
  aarch64: 'arm64',
  arm64: 'arm64',
  // docker inspect 的 Architecture 本就是 GOARCH 风格，直通
  amd64: 'amd64'
}

export interface AgentStatus {
  installed: boolean
  version?: string
  /** 安装时探测到的平台，如 "Linux aarch64" */
  osArch?: string
}

/** agent 二进制目录：打包后在 resources/agent，dev 在仓库 build/agent */
function binaryDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'agent')
  // 注意：主进程会被 electron-vite 打成单文件 out/main/index.js，
  // 所以源码里嵌套多深的 import.meta.url 都只剩两级（与 devIcon 同款算法）
  const mainDir = dirname(fileURLToPath(import.meta.url))
  return join(mainDir, '../../build/agent')
}

/** 订阅/通道的键：宿主机 = sessionId；容器 = sessionId::容器名 */
function keyOf(sessionId: string, containerName?: string): string {
  return containerName ? `${sessionId}::${containerName}` : sessionId
}

interface Channel {
  stream: ClientChannel
  nextId: number
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
}

interface WatchEntry {
  sessionId: string
  containerName?: string
  ports: { owners: Set<WebContents>; active: boolean }
  stats: { owners: Set<WebContents>; active: boolean }
  /** 文件面板等一次性调用方：持有期间通道不因 watch 退订归零而关闭 */
  holders: Set<WebContents>
}

/**
 * 远程助手（dox-agent）的安装与状态。
 *
 * 红线的现行口径（项目负责人拍板）：agent **允许存在，但永远 opt-in** ——
 * 用户显式点「安装」才推送；静默装、开机自启、写系统目录依旧禁止。
 * 安装全程可逆：宿主机删 ~/.dox 即卸载；容器随删除自然消失。
 *
 * 容器内安装是 VS Code Dev Containers 的同款思路：静态二进制 docker cp
 * 进容器（不需要容器里有 shell，distroless 也行）、docker exec -i 起
 * serve 通道。容器是临时的 —— stop/start 二进制还在（文件系统层保留），
 * rm/重建即消失，正好符合「容器里不留长期痕迹」。
 */
export class AgentManager {
  private cache = new Map<string, AgentStatus>()

  constructor(
    private readonly sessions: SessionManager,
    /** 解析父会话上的容器 runtime 二进制（docker/podman），由 ContainerManager 提供 */
    private readonly resolveRuntime: (sessionId: string) => Promise<string | null>
  ) {
    // SSH 断线重连成功 → 按订阅意图重建 serve 通道（agent 保活的核心钩子）
    this.sessions.onStatus(this.onSessionStatus)
  }

  /** 查 agent 是否已装（按目标缓存；装/卸以我们的操作为准，外部手删了刷新即知） */
  async status(sessionId: string, containerName?: string): Promise<AgentStatus> {
    const key = keyOf(sessionId, containerName)
    const cached = this.cache.get(key)
    if (cached) return cached
    const client = this.sessions.getClient(sessionId)
    if (!client) return { installed: false }
    try {
      if (containerName) {
        assertContainerTarget(containerName)
        const binary = await this.resolveRuntime(sessionId)
        if (!binary) return { installed: false }
        // 直接跑二进制：失败（没装/容器停了）就是 NOAGENT，不猜容器里有没有 shell
        const res = await execCapture(client, `${binary} exec ${containerName} ${CTR_BIN} version`, {
          timeoutMs: 8000
        })
        const status: AgentStatus = {
          installed: true,
          version: (JSON.parse(res.stdout.trim()) as { version: string }).version
        }
        this.cache.set(key, status)
        return status
      }
      const res = await execCapture(
        client,
        `/bin/sh -c '~/.dox/dox-agent version 2>/dev/null || echo NOAGENT'`,
        { timeoutMs: 8000 }
      )
      const line = res.stdout.trim()
      const status: AgentStatus =
        line === 'NOAGENT'
          ? { installed: false }
          : { installed: true, version: (JSON.parse(line) as { version: string }).version }
      this.cache.set(key, status)
      return status
    } catch {
      return { installed: false }
    }
  }

  /** 选本地二进制：宿主机看 uname，容器看 inspect（distroless 没有 uname 可跑） */
  private async pickBinary(
    sessionId: string,
    containerName?: string
  ): Promise<{ localBin: string; osArch: string }> {
    const client = this.sessions.getClient(sessionId)
    if (!client) throw new Error('会话已断开，无法安装')

    let osName: string
    let machine: string
    if (containerName) {
      assertContainerTarget(containerName)
      const binary = await this.resolveRuntime(sessionId)
      if (!binary) throw new Error('这台远端没有可用的容器运行时')
      const res = await execCapture(client, `${binary} info`, { timeoutMs: 10_000 })
      const platform = parseDockerInfoPlatform(res.stdout)
      if (!platform) throw new Error('读不到容器运行时的平台信息')
      osName = platform.os
      machine = platform.arch
    } else {
      const uname = (await execCapture(client, 'uname -sm')).stdout.trim()
      const parts = uname.split(/\s+/)
      osName = parts[0] ?? ''
      machine = parts[1] ?? ''
    }

    if (osName.toLowerCase() !== 'linux') {
      throw new Error(`这台${containerName ? '容器' : '远端'}是 ${osName}，助手目前只有 Linux 构建`)
    }
    const goarch = ARCH_MAP[machine]
    if (!goarch) throw new Error(`暂不支持的架构：${machine}（已知 x86_64 / aarch64）`)
    const localBin = join(binaryDir(), `dox-agent-linux-${goarch}`)
    if (!fs.existsSync(localBin)) {
      throw new Error('应用内缺少 agent 构建，请先运行 node scripts/build-agent.mjs')
    }
    return { localBin, osArch: containerName ? `Linux ${machine}（容器）` : `Linux ${machine}` }
  }

  /** 升级安装后掐掉在跑的旧通道：serve 进程内存里还是旧二进制，重连才吃新版本 */
  private restartChannelAfterInstall(key: string): void {
    const ch = this.channels.get(key)
    if (ch) this.dropChannel(key, ch)
  }

  /**
   * 把匹配平台的 agent 二进制推到目标。
   *
   * 宿主机：SFTP 传 .tmp 再 mv（半截失败不破坏旧版本）。
   * 容器：SFTP 传到宿主机 /tmp → docker cp 进容器 → 删宿主机临时文件。
   * docker cp 保留权限位，容器里不需要 chmod（distroless 没有 chmod）。
   */
  async install(sessionId: string, containerName?: string): Promise<AgentStatus> {
    const client = this.sessions.getClient(sessionId)
    if (!client) throw new Error('会话已断开，无法安装')
    const { localBin, osArch } = await this.pickBinary(sessionId, containerName)

    if (containerName) {
      const binary = (await this.resolveRuntime(sessionId))!
      const hostTmp = `/tmp/dox-agent-${randomUUID().slice(0, 8)}.bin`
      const sftp = await this.sessions.sftp(sessionId)
      await new Promise<void>((resolve, reject) => {
        const src = fs.createReadStream(localBin)
        const dst = sftp.createWriteStream(hostTmp)
        src.on('error', reject)
        dst.on('error', reject)
        dst.on('close', () => resolve())
        src.pipe(dst)
      })
      try {
        await execCapture(client, `/bin/sh -c 'chmod 755 "${hostTmp}" && ${binary} cp "${hostTmp}" ${containerName}:${CTR_BIN}'`)
      } finally {
        await execCapture(client, `/bin/sh -c 'rm -f "${hostTmp}"'`).catch(() => undefined)
      }
      // 落点自检：version 跑不通等于没装成
      const out = await execCapture(client, `${binary} exec ${containerName} ${CTR_BIN} version`, {
        timeoutMs: 8000
      })
      const version = (JSON.parse(out.stdout.trim()) as { version: string }).version
      const status: AgentStatus = { installed: true, version, osArch }
      this.cache.set(keyOf(sessionId, containerName), status)
      this.restartChannelAfterInstall(keyOf(sessionId, containerName))
      return status
    }

    // 宿主机：先传 .tmp 再 mv
    const home = (await execCapture(client, `/bin/sh -c 'echo "$HOME"'`)).stdout.trim()
    if (!home) throw new Error('拿不到远端 HOME 目录')
    const remoteDir = `${home}/.dox`
    const tmpPath = `${remoteDir}/dox-agent.tmp`
    const dstPath = `${remoteDir}/dox-agent`
    const sftp = await this.sessions.sftp(sessionId)
    await mkdirRemoteRecursive(sftp, remoteDir)

    await new Promise<void>((resolve, reject) => {
      const src = fs.createReadStream(localBin)
      const dst = sftp.createWriteStream(tmpPath)
      src.on('error', reject)
      dst.on('error', reject)
      dst.on('close', () => resolve())
      src.pipe(dst)
    })
    await execCapture(client, `/bin/sh -c 'chmod 755 "${tmpPath}" && mv "${tmpPath}" "${dstPath}"'`)

    const out = await execCapture(client, `"${dstPath}" version`, { timeoutMs: 8000 })
    const version = (JSON.parse(out.stdout.trim()) as { version: string }).version

    const status: AgentStatus = { installed: true, version, osArch }
    this.cache.set(keyOf(sessionId), status)
    this.restartChannelAfterInstall(keyOf(sessionId))
    return status
  }

  /** 会话断开时清掉它的全部目标（宿主机 + 各容器）的缓存与通道；订阅意图保留待重建 */
  invalidate(sessionId: string): void {
    for (const [key, ch] of [...this.channels]) {
      if (key === sessionId || key.startsWith(`${sessionId}::`)) {
        this.cache.delete(key)
        this.dropChannel(key, ch)
      }
    }
    this.cache.delete(sessionId)
  }

  // ---- serve 通道（长连接 NDJSON，端口推送等流式能力的承载）----

  private channels = new Map<string, Channel>()

  /**
   * 流式能力的**订阅意图**：谁订阅了、watch 是否在活通道上跑着。
   * 与通道记录分离 —— 通道随 SSH 断线（或容器停止）死掉时意图保留，
   * 重连成功后按它重建。ports / stats 两路订阅共用一条 serve 通道。
   */
  private watches = new Map<string, WatchEntry>()

  private watchEntry(sessionId: string, containerName?: string): WatchEntry {
    const key = keyOf(sessionId, containerName)
    let w = this.watches.get(key)
    if (!w) {
      w = {
        sessionId,
        containerName,
        ports: { owners: new Set(), active: false },
        stats: { owners: new Set(), active: false },
        holders: new Set()
      }
      this.watches.set(key, w)
    }
    return w
  }

  /** 断线重连成功 → 该会话所有目标（宿主机 + 各容器）按订阅意图重建 */
  private onSessionStatus = (e: { id: string; status: string; reconnected?: boolean }): void => {
    if (e.status !== 'connected' || !e.reconnected) return
    for (const [key, w] of this.watches) {
      if (w.sessionId !== e.id) continue
      const stale =
        (w.ports.owners.size > 0 && !w.ports.active) || (w.stats.owners.size > 0 && !w.stats.active)
      if (stale) void this.rebuildWatch(key, w)
    }
  }

  private async rebuildWatch(key: string, w: WatchEntry): Promise<void> {
    for (const lane of [w.ports, w.stats]) {
      for (const owner of lane.owners) {
        if (owner.isDestroyed()) lane.owners.delete(owner)
      }
    }
    for (const holder of w.holders) {
      if (holder.isDestroyed()) w.holders.delete(holder)
    }
    if (w.ports.owners.size + w.stats.owners.size + w.holders.size === 0) {
      if (this.watches.get(key) === w) this.watches.delete(key)
      return
    }
    try {
      const ch = await this.connect(w.sessionId, w.containerName)
      if (this.watches.get(key) !== w) {
        this.dropChannel(key, ch)
        return
      }
      if (w.ports.owners.size > 0 && !w.ports.active) {
        await this.callOn(ch, 'watch_ports', { interval_ms: 3000 })
        w.ports.active = true
      }
      if (w.stats.owners.size > 0 && !w.stats.active) {
        await this.callOn(ch, 'watch_stats', { interval_ms: 3000 })
        w.stats.active = true
      }
    } catch {
      // 重建失败：留在降级态（渲染层轮询顶着），下次重连/重试再试
      this.broadcast(w, { event: 'agent_closed' })
    }
  }

  /**
   * 统一广播：按事件类型路由到对应泳道的订阅者（订阅者以意图表为准）。
   * 事件带 containerName —— 同一条 SSH 会话上宿主机与多个容器并存时靠它区分。
   * agent_closed 两泳道都通知 —— 它是通道级事件，不是业务事件。
   */
  private broadcast(w: WatchEntry, payload: { event?: string } & object): void {
    const statsLane = payload.event === 'stats' || payload.event === 'stats_error'
    const channel = statsLane ? IpcChannels.agentStats : IpcChannels.agentPorts
    const owners =
      payload.event === 'agent_closed'
        ? new Set([...w.ports.owners, ...w.stats.owners])
        : statsLane
          ? w.stats.owners
          : w.ports.owners
    for (const owner of owners) {
      if (!owner.isDestroyed()) owner.send(channel, w.sessionId, w.containerName ?? null, payload)
    }
  }

  /** 通道死的统一处理：摘表、清空 pending、标记意图待重建、通知渲染层降级 */
  private dropChannel(key: string, ch: Channel): void {
    if (this.channels.get(key) === ch) this.channels.delete(key)
    for (const p of ch.pending.values()) p.reject(new Error('agent 通道已断开'))
    ch.pending.clear()
    try { ch.stream.close() } catch { /* 已死 */ }
    const w = this.watches.get(key)
    if (w) {
      w.ports.active = false
      w.stats.active = false
      this.broadcast(w, { event: 'agent_closed' })
    }
  }

  /**
   * 建立（或复用）serve 通道：启动 agent 进程、完成 hello 握手。
   * 宿主机直接 exec；容器经 docker exec -i（不要 -t，pty 会把 NDJSON 搅脏）。
   */
  private async connect(sessionId: string, containerName?: string): Promise<Channel> {
    const key = keyOf(sessionId, containerName)
    const existing = this.channels.get(key)
    if (existing) return existing

    const client = this.sessions.getClient(sessionId)
    if (!client) throw new Error('会话已断开')

    let command: string
    if (containerName) {
      assertContainerTarget(containerName)
      const binary = await this.resolveRuntime(sessionId)
      if (!binary) throw new Error('这台远端没有可用的容器运行时')
      command = `${binary} exec -i ${containerName} ${CTR_BIN} serve`
    } else {
      command = `~/.dox/dox-agent serve`
    }

    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(command, { pty: false }, (err, ch) => (err ? reject(err) : resolve(ch)))
    })

    const ch: Channel = { stream, nextId: 1, pending: new Map() }
    this.channels.set(key, ch)
    const w = this.watches.get(key)

    let buf = ''
    stream.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        let msg: { id?: number; event?: string; result?: unknown; error?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.event) {
          // agent 的行格式是 {event, data:{…}}，拍平成渲染层契约的平铺载荷
          if (w) this.broadcast(w, { event: msg.event, ...((msg as { data?: object }).data ?? {}) })
          continue
        }
        if (msg.id !== undefined) {
          const p = ch.pending.get(msg.id)
          if (p) {
            ch.pending.delete(msg.id)
            msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
          }
        }
      }
    })
    const onDead = (): void => this.dropChannel(key, ch)
    stream.on('close', onDead)
    stream.on('error', onDead)

    // hello 握手：确认对面真是 agent 而不是 shell 报错
    try {
      await this.callOn(ch, 'hello', {})
    } catch (err) {
      this.dropChannel(key, ch)
      throw err
    }
    return ch
  }

  private callOn(
    ch: Channel,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const id = ch.nextId++
    return new Promise((resolve, reject) => {
      ch.pending.set(id, { resolve, reject })
      ch.stream.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  /**
   * 订阅端口推送：登记意图（首个订阅者建通道并开 watch_ports）；
   * 通道死不代表退订 —— 重连后自动重建，渲染层无需重订。
   */
  async watchPorts(sessionId: string, containerName: string | undefined, owner: WebContents): Promise<void> {
    const w = this.watchEntry(sessionId, containerName)
    w.ports.owners.add(owner)
    if (w.ports.active) return
    const ch = await this.connect(sessionId, containerName)
    await this.callOn(ch, 'watch_ports', { interval_ms: 3000 })
    // connect/callOn 等待期间可能已退订归零：意图没了就不标 active
    if (this.watches.get(keyOf(sessionId, containerName)) === w && w.ports.owners.size > 0) {
      w.ports.active = true
    }
  }

  /** 订阅系统状态推送（CPU/内存/GPU），机制与 watchPorts 相同、共用通道 */
  async watchStats(sessionId: string, containerName: string | undefined, owner: WebContents): Promise<void> {
    const w = this.watchEntry(sessionId, containerName)
    w.stats.owners.add(owner)
    if (w.stats.active) return
    const ch = await this.connect(sessionId, containerName)
    await this.callOn(ch, 'watch_stats', { interval_ms: 3000 })
    if (this.watches.get(keyOf(sessionId, containerName)) === w && w.stats.owners.size > 0) {
      w.stats.active = true
    }
  }

  unwatchPorts(sessionId: string, containerName: string | undefined, owner: WebContents): void {
    this.unwatch(sessionId, containerName, owner, 'ports')
  }

  unwatchStats(sessionId: string, containerName: string | undefined, owner: WebContents): void {
    this.unwatch(sessionId, containerName, owner, 'stats')
  }

  /** 退订：该泳道归零只是不再推送；泳道与 holder 全归零才 stop + 关通道（远端不留闲进程） */
  private unwatch(sessionId: string, containerName: string | undefined, owner: WebContents, lane: 'ports' | 'stats'): void {
    const key = keyOf(sessionId, containerName)
    const w = this.watches.get(key)
    if (!w) return
    w[lane].owners.delete(owner)
    if (w.ports.owners.size + w.stats.owners.size + w.holders.size > 0) return
    this.watches.delete(key)
    const ch = this.channels.get(key)
    if (!ch) return
    // stop 是尽力而为：通道可能 already 半死，关流兜底
    void this.callOn(ch, 'stop', {}).catch(() => undefined)
    setTimeout(() => {
      try { ch.stream.close() } catch { /* 已死 */ }
    }, 500).unref?.()
  }

  // ---- 一次性调用（fs_* 文件方法等请求/响应式能力）----

  /**
   * 在目标通道上发一个请求/响应调用（fs_list/fs_read/…）。
   * 通道不存在就现建 —— 文件面板打开期间由 holdChannel 保证不被退订收掉。
   */
  async call(sessionId: string, containerName: string | undefined, method: string, params: unknown): Promise<unknown> {
    const ch = await this.connect(sessionId, containerName)
    return this.callOn(ch, method, params)
  }

  /** 持有通道（文件面板挂载期间）：watch 退订归零也不关；释放后归零才收 */
  holdChannel(sessionId: string, containerName: string | undefined, owner: WebContents): void {
    this.watchEntry(sessionId, containerName).holders.add(owner)
  }

  releaseChannel(sessionId: string, containerName: string | undefined, owner: WebContents): void {
    const key = keyOf(sessionId, containerName)
    const w = this.watches.get(key)
    if (!w) return
    w.holders.delete(owner)
    if (w.ports.owners.size + w.stats.owners.size + w.holders.size > 0) return
    this.watches.delete(key)
    const ch = this.channels.get(key)
    if (!ch) return
    void this.callOn(ch, 'stop', {}).catch(() => undefined)
    setTimeout(() => {
      try { ch.stream.close() } catch { /* 已死 */ }
    }, 500).unref?.()
  }
}

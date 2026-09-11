import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, type WebContents } from 'electron'
import type { ClientChannel } from 'ssh2'
import type { SessionManager } from '../ssh/SessionManager'
import { execCapture } from '../ssh/remoteExec'
import { mkdirRemoteRecursive } from '../sftp/sftpUtils'
import { IpcChannels } from '../../shared/ipc'

const REMOTE_BIN = '.dox/dox-agent'

/** uname -m → GOARCH（遇到新架构时在这里加，而不是让正则猜） */
const ARCH_MAP: Record<string, string> = {
  x86_64: 'amd64',
  aarch64: 'arm64',
  arm64: 'arm64'
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

/**
 * 远程助手（dox-agent）的安装与状态。
 *
 * 红线的新口径（项目负责人拍板）：agent **允许存在，但永远 opt-in** ——
 * 用户在某台机器上显式点「安装助手」才推送；静默装、开机自启、写系统
 * 目录依旧禁止。安装全程可逆：删掉 ~/.dox 目录即完全卸载。
 */
export class AgentManager {
  private cache = new Map<string, AgentStatus>()

  constructor(private readonly sessions: SessionManager) {}

  /** 查 agent 是否已装（按会话缓存；装/卸以我们的操作为准，外部手删了刷新即知） */
  async status(sessionId: string): Promise<AgentStatus> {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const client = this.sessions.getClient(sessionId)
    if (!client) return { installed: false }
    try {
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
      this.cache.set(sessionId, status)
      return status
    } catch {
      return { installed: false }
    }
  }

  /**
   * 把匹配平台的 agent 二进制推到远端 ~/.dox/dox-agent。
   *
   * 先传 .tmp 再 mv：传到一半失败的话，落点的旧版本（或没有）原样保留，
   * 不会留下一个不能跑的半截二进制被 version 校验误判成已安装。
   */
  async install(sessionId: string): Promise<AgentStatus> {
    const client = this.sessions.getClient(sessionId)
    if (!client) throw new Error('会话已断开，无法安装')

    // 1. 平台探测 → 选二进制
    const uname = (await execCapture(client, 'uname -sm')).stdout.trim()
    const [osName, machine] = uname.split(/\s+/)
    if (osName !== 'Linux') {
      throw new Error(`这台远端是 ${osName}，助手目前只有 Linux 构建`)
    }
    const goarch = ARCH_MAP[machine ?? '']
    if (!goarch) throw new Error(`暂不支持的架构：${machine}（已知 x86_64 / aarch64）`)
    const localBin = join(binaryDir(), `dox-agent-linux-${goarch}`)
    if (!fs.existsSync(localBin)) {
      throw new Error('应用内缺少 agent 构建，请先运行 node scripts/build-agent.mjs')
    }

    // 2. 远端建目录
    const home = (await execCapture(client, `/bin/sh -c 'echo "$HOME"'`)).stdout.trim()
    if (!home) throw new Error('拿不到远端 HOME 目录')
    const remoteDir = `${home}/.dox`
    const tmpPath = `${remoteDir}/dox-agent.tmp`
    const dstPath = `${remoteDir}/dox-agent`
    const sftp = await this.sessions.sftp(sessionId)
    await mkdirRemoteRecursive(sftp, remoteDir)

    // 3. 上传（本地 ~2MB，走流不占内存）
    await new Promise<void>((resolve, reject) => {
      const src = fs.createReadStream(localBin)
      const dst = sftp.createWriteStream(tmpPath)
      src.on('error', reject)
      dst.on('error', reject)
      dst.on('close', () => resolve())
      src.pipe(dst)
    })
    await execCapture(client, `/bin/sh -c 'chmod 755 "${tmpPath}" && mv "${tmpPath}" "${dstPath}"'`)

    // 4. 落点自检：version 跑不通等于没装成
    const out = await execCapture(client, `"${dstPath}" version`, { timeoutMs: 8000 })
    const version = (JSON.parse(out.stdout.trim()) as { version: string }).version

    const status: AgentStatus = { installed: true, version, osArch: uname }
    this.cache.set(sessionId, status)
    return status
  }

  /** 会话断开时清缓存（重连后重新探，外部手删也能如实反映） */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId)
    // serve 通道随连接一起死：关掉并通知渲染层降级
    const ch = this.channels.get(sessionId)
    if (ch) {
      this.channels.delete(sessionId)
      try { ch.stream.close() } catch { /* 已死 */ }
      for (const owner of ch.owners) {
        if (!owner.isDestroyed()) owner.send(IpcChannels.agentPorts, sessionId, { event: 'agent_closed' })
      }
    }
  }

  // ---- serve 通道（长连接 NDJSON，端口推送等流式能力的承载）----

  private channels = new Map<string, {
    stream: ClientChannel
    nextId: number
    pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
    /** 订阅端口事件的渲染进程（分屏/多面板可多个，归零即关通道） */
    owners: Set<WebContents>
  }>()

  /**
   * 建立（或复用）serve 通道：启动 agent 进程、完成 hello 握手。
   * 通道死的统一处理：清空 pending、通知所有订阅方降级（agent_closed）。
   */
  private async connect(sessionId: string): Promise<{
    stream: ClientChannel
    nextId: number
    pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
    owners: Set<WebContents>
  }> {
    const existing = this.channels.get(sessionId)
    if (existing) return existing

    const client = this.sessions.getClient(sessionId)
    if (!client) throw new Error('会话已断开')

    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec('~/.dox/dox-agent serve', { pty: false }, (err, ch) =>
        err ? reject(err) : resolve(ch)
      )
    })

    const ch = {
      stream,
      nextId: 1,
      pending: new Map(),
      owners: new Set<WebContents>()
    }
    this.channels.set(sessionId, ch)

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
          // 端口事件广播给所有订阅的渲染进程。
          // agent 的行格式是 {event, data:{listening,added,removed}}，这里拍平成
          // {event, listening, added, removed} —— 渲染层（shared/api.ts 的契约）不嵌套。
          const flat = { event: msg.event, ...((msg as { data?: object }).data ?? {}) }
          for (const owner of ch.owners) {
            if (!owner.isDestroyed()) owner.send(IpcChannels.agentPorts, sessionId, flat)
          }
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
    const onDead = (): void => {
      if (this.channels.get(sessionId) !== ch) return
      this.channels.delete(sessionId)
      for (const p of ch.pending.values()) p.reject(new Error('agent 通道已断开'))
      ch.pending.clear()
      for (const owner of ch.owners) {
        if (!owner.isDestroyed()) owner.send(IpcChannels.agentPorts, sessionId, { event: 'agent_closed' })
      }
    }
    stream.on('close', onDead)
    stream.on('error', onDead)

    // hello 握手：确认对面真是 agent 而不是 shell 报错
    await this.callOn(ch, 'hello', {})
    return ch
  }

  private callOn(
    ch: { stream: ClientChannel; nextId: number; pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> },
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
   * 订阅端口推送：首次调用建立通道并开启 watch_ports；
   * 渲染进程退订归零后给 agent 发 stop 并关通道（远端不留闲进程）。
   */
  async watchPorts(sessionId: string, owner: WebContents): Promise<void> {
    const ch = await this.connect(sessionId)
    const first = ch.owners.size === 0
    ch.owners.add(owner)
    if (first) await this.callOn(ch, 'watch_ports', { interval_ms: 3000 })
  }

  unwatchPorts(sessionId: string, owner: WebContents): void {
    const ch = this.channels.get(sessionId)
    if (!ch) return
    ch.owners.delete(owner)
    if (ch.owners.size > 0) return
    this.channels.delete(sessionId)
    // stop 是尽力而为：通道可能 already 半死，关流兜底
    void this.callOn(ch, 'stop', {}).catch(() => undefined)
    setTimeout(() => {
      try { ch.stream.close() } catch { /* 已死 */ }
    }, 500).unref?.()
  }
}

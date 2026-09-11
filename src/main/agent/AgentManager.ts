import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import type { SessionManager } from '../ssh/SessionManager'
import { execCapture } from '../ssh/remoteExec'
import { mkdirRemoteRecursive } from '../sftp/sftpUtils'

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
  }
}

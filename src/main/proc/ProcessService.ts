/**
 * 进程管理的数据通路：列进程 / 结束进程。
 *
 * 三条路按目标能力选（调用方不用管）：
 *  - 目标装了 agent ≥0.4.0 → ps_list/ps_kill（直读 /proc，distroless 容器也能列）
 *  - 宿主机没装 agent → 退化 `ps -eo …` 一次性命令（不装任何东西；
 *    CPU% 是 ps 口径的累计均值，不是 agent 的瞬时差分 —— 有助手才是完整体验）
 *  - 容器没装 agent → 抛错指路（容器里可能连 ps 和 sh 都没有）
 */
import type { Client } from 'ssh2'
import { execCapture } from '../ssh/remoteExec'
import type { AgentManager } from '../agent/AgentManager'
import { agentVersionOlder } from '../../shared/agentVersion'

export interface ProcInfo {
  pid: number
  ppid: number
  user: string
  rssBytes: number
  cpuPercent: number
  memPercent: number
  command: string
}

export interface ProcListResult {
  /** agent = 完整能力（瞬时 CPU 差分）；fallback-ps = ps 命令退化（CPU 为累计均值） */
  via: 'agent' | 'fallback-ps'
  processes: ProcInfo[]
}

/** 目标能不能用 agent 的 ps_*（装了且 ≥0.4.0） */
async function agentCapable(
  agents: AgentManager,
  sessionId: string,
  containerName?: string
): Promise<boolean> {
  try {
    const st = await agents.status(sessionId, containerName)
    return !!st.installed && !!st.version && !agentVersionOlder(st.version, '0.4.0')
  } catch {
    return false
  }
}

/** ps -eo 的 %CPU 是「进程存活期均值」，列里直接展示会全是 0.0 —— 保留但文案说明 */
const PS_COMMAND = `ps -eo pid=,ppid=,user=,pcpu=,pmem=,rss=,args= 2>/dev/null`

function parsePsOutput(stdout: string): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      cpuPercent: Number(m[4]),
      memPercent: Number(m[5]),
      rssBytes: Number(m[6]) * 1024, // ps 的 rss 是 kB
      command: m[7]
    })
  }
  return out
}

export class ProcessService {
  constructor(
    private readonly getClient: (sessionId: string) => Client | undefined,
    private readonly agents: AgentManager
  ) {}

  async list(sessionId: string, containerName?: string): Promise<ProcListResult> {
    if (await agentCapable(this.agents, sessionId, containerName)) {
      const r = (await this.agents.call(sessionId, containerName, 'ps_list', { sample_ms: 300 })) as {
        processes: {
          pid: number
          ppid: number
          user: string
          rss_bytes: number
          cpu_percent: number
          mem_percent: number
          command: string
        }[]
      }
      return {
        via: 'agent',
        processes: r.processes.map((p) => ({
          pid: p.pid,
          ppid: p.ppid,
          user: p.user,
          rssBytes: p.rss_bytes,
          cpuPercent: p.cpu_percent,
          memPercent: p.mem_percent,
          command: p.command
        }))
      }
    }
    if (containerName) {
      throw new Error('容器里的进程管理需要容器助手 v0.4.0（侧栏「远程助手」安装/升级）')
    }
    const client = this.getClient(sessionId)
    if (!client) throw new Error('会话不存在或已断开')
    const res = await execCapture(client, PS_COMMAND, { timeoutMs: 8000 })
    return { via: 'fallback-ps', processes: parsePsOutput(res.stdout) }
  }

  async kill(sessionId: string, pid: number, signal: 15 | 9, containerName?: string): Promise<void> {
    if (!Number.isInteger(pid) || pid < 2) throw new Error('非法的 pid')
    if (await agentCapable(this.agents, sessionId, containerName)) {
      await this.agents.call(sessionId, containerName, 'ps_kill', { pid, signal })
      return
    }
    if (containerName) {
      throw new Error('容器里结束进程需要容器助手 v0.4.0（侧栏「远程助手」安装/升级）')
    }
    const client = this.getClient(sessionId)
    if (!client) throw new Error('会话不存在或已断开')
    // pid 已校验是纯整数，signal 是白名单枚举 —— 拼命令没有注入面
    await execCapture(client, `kill -${signal} ${pid}`, { timeoutMs: 8000 })
  }
}

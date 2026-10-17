import { execFile } from 'node:child_process'
import type { WslDistroInfo, WslDistroState } from '../../shared/types'

/** wsl.exe 在管道中通常输出 UTF-16LE；保留 Buffer 接口，避免先按 UTF-8 解码成乱码 */
export type WslRunner = (args: string[]) => Promise<Buffer | string>

const WSL_TIMEOUT_MS = 10_000

export function runWslCommand(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      args,
      { windowsHide: true, encoding: 'buffer', timeout: WSL_TIMEOUT_MS },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout as unknown as Buffer)
      }
    )
  })
}

/** 统一清理 BOM、NUL 和 CRLF；字符串入参方便纯逻辑测试 */
export function decodeWslOutput(output: Buffer | string): string {
  const text = typeof output === 'string' ? output : output.toString('utf16le')
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return withoutBom.replace(/\0/g, '').replace(/\r\n?/g, '\n')
}

function stateOf(value: string): WslDistroState {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'running') return 'running'
  if (normalized === 'stopped') return 'stopped'
  return 'unknown'
}

/**
 * 解析 wsl -l -v。只依赖列结构，不匹配 NAME / STATE 等表头文字：
 * 名称、状态、版本之间至少两个空白，最右侧版本列必须是数字。
 * 任何数据行不可靠都整批失败，让调用方回退 quiet，而不是返回缺行列表。
 */
export function parseWslVerbose(output: Buffer | string): WslDistroInfo[] {
  const lines = decodeWslOutput(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return []

  return lines.slice(1).map((line) => {
    const isDefault = line.startsWith('*')
    const body = (isDefault ? line.slice(1) : line).trim()
    const columns = body.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean)
    if (columns.length !== 3 || !columns[0] || !/^\d+$/.test(columns[2])) {
      throw new Error(`无法解析 WSL verbose 行：${line}`)
    }
    return {
      distro: columns[0],
      isDefault,
      state: stateOf(columns[1])
    }
  })
}

export function parseWslQuiet(output: Buffer | string): string[] {
  return decodeWslOutput(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** verbose 拿不到可靠结构时回退 quiet；两个命令都失败才视为本次探测失败 */
export async function probeWslDistros(run: WslRunner = runWslCommand): Promise<WslDistroInfo[]> {
  try {
    const verbose = await run(['-l', '-v'])
    try {
      return parseWslVerbose(verbose)
    } catch {
      // 旧版或本地化输出结构不可用时，quiet 至少还能提供名称
    }
  } catch {
    // WSL 不存在、超时等也走 quiet，保持与旧探测路径一致
  }

  const quiet = await run(['-l', '-q'])
  return parseWslQuiet(quiet).map((distro) => ({ distro, state: 'unknown' }))
}

/** 查询发行版默认用户的 Linux home；这是 Linux stdout，应按 UTF-8 而不是 wsl -l 的 UTF-16LE 解码 */
export async function queryWslHome(distro: string, run: WslRunner = runWslCommand): Promise<string> {
  try {
    const output = await run(['-d', distro, '-e', 'sh', '-c', 'cd "$HOME" && pwd -P'])
    const text = typeof output === 'string' ? output : output.toString('utf8')
    const home = text.replace(/\r?\n$/, '')
    if (!home.startsWith('/') || /[\0\r\n\\]/.test(home)) return '/'
    return home
  } catch {
    // home 查询失败只能落 Linux 根，绝不能回退 Windows home
    return '/'
  }
}

/** WSL 启动参数集中生成：带空格的发行版名也始终是单独一个 argv 元素 */
export function wslLaunchSpec(distro: string): { command: string; args: string[] } {
  return { command: 'wsl.exe', args: ['-d', distro] }
}

/**
 * 串行调度 WSL 探测：首次普通调用共享一个 Promise；运行期间的强制刷新
 * 合并为一个尾随任务，保证一次真正的新探测，同时避免连点造成命令风暴。
 */
export class WslProbeScheduler {
  private readonly probe: () => Promise<void>
  private active: Promise<void> | null = null
  private queued: Promise<void> | null = null
  private initialized = false

  constructor(probe: () => Promise<void>) {
    this.probe = probe
  }

  ensure(forceRefresh = false): Promise<void> {
    if (forceRefresh) return this.refresh()
    if (this.initialized) return Promise.resolve()
    return this.start()
  }

  private start(): Promise<void> {
    if (this.active) return this.active
    // 延后到微任务，确保 finally 回调不会在 task 赋值前同步执行
    const probing = Promise.resolve().then(this.probe)
    const task = probing.finally(() => {
      this.initialized = true
      if (this.active === task) this.active = null
    })
    this.active = task
    return task
  }

  private refresh(): Promise<void> {
    if (this.queued) return this.queued
    const active = this.active
    if (!active) return this.start()

    const queued = (async () => {
      try {
        await active
      } catch {
        // 前一次失败也要允许用户显式刷新
      }
      await this.start()
    })()
    this.queued = queued
    const clear = (): void => {
      if (this.queued === queued) this.queued = null
    }
    void queued.then(clear, clear)
    return queued
  }
}

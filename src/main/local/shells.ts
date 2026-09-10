import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { LocalShellInfo } from '../../shared/types'
import psProfile from './scripts/dox-profile.ps1?raw'
import bashrc from './scripts/dox-bashrc.sh?raw'

/** 探测到的 shell 记录（info 给 UI，resolve 用内部字段） */
interface DetectedShell extends LocalShellInfo {
  command?: string
  args?: string[]
  /** 注入方式 */
  integration?: 'powershell' | 'bash' | 'cmd' | 'none'
}

/**
 * 探测结果缓存。
 * probed 与 detected 必须分开：若本机一个 shell 都没探到（组策略限制的精简系统），
 * 只看 detected.length 会导致每次调用都重跑一遍子进程探测。
 */
let detected: DetectedShell[] = []
let probed = false

/** integration 脚本落盘目录（PowerShell 需要真实文件路径才能 dot-source） */
function scriptsDir(): string {
  return join(app.getPath('userData'), 'shell-integration')
}

/**
 * 把 integration 脚本写入 userData。
 * 用 ?raw 内联进产物，运行时再落盘 —— 打包后也能正常工作。
 */
function ensureScripts(): { ps1: string; sh: string } {
  const dir = scriptsDir()
  mkdirSync(dir, { recursive: true })
  const ps1 = join(dir, 'dox-profile.ps1')
  const sh = join(dir, 'dox-bashrc.sh')
  writeFileSync(ps1, psProfile, 'utf8')
  writeFileSync(sh, bashrc, 'utf8')
  return { ps1, sh }
}

/** 在常见安装位置之外，用 PATH 兜底查找可执行文件（同步，只在路径未命中时调用） */
function onPath(exe: string): string | undefined {
  try {
    const out = execFileSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true })
    return out.split(/\r?\n/)[0]?.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * 按顺序返回第一个存在的路径。
 * 入参是 thunk 而不是字符串数组 —— 否则实参会被全部求值，
 * 路径已经命中时仍然会白跑一次 where.exe。
 */
function firstExisting(...candidates: Array<() => string | undefined>): string | undefined {
  for (const get of candidates) {
    const value = get()
    if (value && existsSync(value)) return value
  }
  return undefined
}

/** 列出 WSL 已安装的发行版（异步：wsl.exe 首次调用可能拉起服务，耗时数秒） */
function listWslDistrosAsync(): Promise<string[]> {
  return new Promise((resolve) => {
    // 必须用 encoding:'buffer' 拿原始字节：wsl.exe 输出是 UTF-16LE，
    // 按默认 utf8 解码会把发行版名变成乱码
    execFile('wsl.exe', ['-l', '-q'], { windowsHide: true, encoding: 'buffer' }, (err, stdout) => {
      if (err) return resolve([])
      const text = (stdout as unknown as Buffer).toString('utf16le')
      resolve(
        text
          .replace(/\0/g, '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      )
    })
  })
}

/** 同步探测基础 shell（不碰 WSL，避免阻塞主进程） */
function probeBaseSync(): DetectedShell[] {
  const list: DetectedShell[] = []

  if (process.platform !== 'win32') {
    const { sh } = ensureScripts()
    const shell = process.env['SHELL'] ?? '/bin/bash'
    return [
      {
        id: 'default',
        name: shell.split('/').pop() ?? shell,
        integrated: true,
        command: shell,
        args: ['--rcfile', sh, '-i'],
        integration: 'bash'
      }
    ]
  }

  const { ps1, sh } = ensureScripts()
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'

  // cmd 放首位 = 默认：靠 PROMPT 的 $P 发 OSC 7 上报目录，
  // 无 PSReadLine 逐键重绘，行为最稳（代价是拿不到退出码）
  const cmd = process.env['COMSPEC']
  if (cmd) {
    list.push({
      id: 'cmd',
      name: '命令提示符 (cmd)',
      integrated: false,
      command: cmd,
      args: [],
      integration: 'cmd'
    })
  }

  const pwsh = firstExisting(
    () => join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    () => onPath('pwsh.exe')
  )
  if (pwsh) {
    list.push({
      id: 'pwsh',
      name: 'PowerShell 7',
      integrated: true,
      command: pwsh,
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${ps1}'`],
      integration: 'powershell'
    })
  }

  const winPs = firstExisting(
    () =>
      join(
        process.env['SystemRoot'] ?? 'C:\\WINDOWS',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
    () => onPath('powershell.exe')
  )
  if (winPs) {
    list.push({
      id: 'powershell',
      name: 'Windows PowerShell',
      integrated: true,
      command: winPs,
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${ps1}'`],
      integration: 'powershell'
    })
  }

  const gitBash = firstExisting(
    () => join(programFiles, 'Git', 'bin', 'bash.exe'),
    () => join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    () => onPath('bash.exe')
  )
  if (gitBash) {
    list.push({
      id: 'gitbash',
      name: 'Git Bash',
      integrated: true,
      command: gitBash,
      args: ['--rcfile', sh, '-i'],
      integration: 'bash'
    })
  }

  return list
}

/**
 * 列出可用的本地 shell（同步路径，不探测 WSL —— 那会阻塞主进程）。
 * WSL 发行版由 prewarmShells() 异步补齐。
 */
export function detectShells(): DetectedShell[] {
  if (!probed) {
    detected = probeBaseSync()
    probed = true
  }
  return detected
}

/**
 * 启动后异步预热：补上 WSL 发行版。
 * 必须在 app ready 之后调用，且不要 await 在关键路径上。
 */
export async function prewarmShells(): Promise<void> {
  detectShells()
  if (process.platform !== 'win32') return
  try {
    const distros = await listWslDistrosAsync()
    const wslEntries: DetectedShell[] = distros.map((distro) => ({
      id: `wsl:${distro}`,
      name: `WSL · ${distro}`,
      integrated: false,
      command: 'wsl.exe',
      args: ['-d', distro],
      integration: 'none'
    }))
    const withoutWsl = detected.filter((s) => !s.id.startsWith('wsl:'))
    detected = [...withoutWsl, ...wslEntries]
  } catch {
    /* WSL 不可用不影响其他 shell */
  }
}

export interface ResolvedShell {
  command: string
  args: string[]
  /** 需要注入的额外环境变量（cmd 的 PROMPT） */
  env: Record<string, string>
}

/**
 * 解析出实际 spawn 用的命令。
 * shellId 未指定或已失效时回退到列表第一项（Windows 下是 cmd）。
 */
export function resolveShell(shellId?: string): ResolvedShell {
  const shells = detectShells()
  const env: Record<string, string> = {}

  // WSL 的 spawn 参数可以直接从 id 推出，不必等异步探测完成
  if (shellId?.startsWith('wsl:')) {
    return { command: 'wsl.exe', args: ['-d', shellId.slice(4)], env }
  }

  const shell = shells.find((s) => s.id === shellId) ?? shells[0]
  if (!shell?.command) throw new Error('本机未找到可用的本地 shell')

  if (shell.integration === 'cmd') {
    // 用 $P（cmd 在每次渲染提示符时求值的路径码）上报 OSC 7。
    // 注意不能用 %CD%：环境变量在 PROMPT 里不会被展开，会原样输出。
    env['PROMPT'] = '$E]7;file:///$P$E\\$P$G'
  }

  return { command: shell.command, args: shell.args ?? [], env }
}

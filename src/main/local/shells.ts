import { execFileSync } from 'node:child_process'
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

/** id → 探测结果；resolveShell 用它取命令与参数 */
let detected: DetectedShell[] = []

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

/** 在常见安装位置之外，用 PATH 兜底查找可执行文件 */
function onPath(exe: string): string | undefined {
  try {
    const out = execFileSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true })
    return out.split(/\r?\n/)[0]?.trim() || undefined
  } catch {
    return undefined
  }
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => p && existsSync(p))
}

/** 列出 WSL 已安装的发行版（输出为 UTF-16LE） */
function listWslDistros(): string[] {
  try {
    const buf = execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true })
    return buf
      .toString('utf16le')
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 探测本机可用的本地 shell。
 * 结果缓存，仅首次调用时做 IO 探测。
 */
export function detectShells(): LocalShellInfo[] {
  if (detected.length) return detected.map(({ command: _c, args: _a, integration: _i, ...info }) => info)

  const list: DetectedShell[] = []

  if (process.platform === 'win32') {
    const { ps1, sh } = ensureScripts()
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'

    // PowerShell 7
    const pwsh = firstExisting([
      join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      onPath('pwsh.exe') ?? ''
    ])
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

    // Windows PowerShell 5.1
    const winPs = firstExisting([
      join(process.env['SystemRoot'] ?? 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      onPath('powershell.exe') ?? ''
    ])
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

    // cmd.exe：靠 PROMPT 里的 $E 发 OSC 7，拿不到退出码
    const cmd = process.env['COMSPEC'] ?? onPath('cmd.exe')
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

    // Git Bash
    const gitBash = firstExisting([
      join(programFiles, 'Git', 'bin', 'bash.exe'),
      join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
      onPath('bash.exe') ?? ''
    ])
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

    // WSL：集成脚本在 Windows 侧，跨文件系统注入较脆，先不注入
    for (const distro of listWslDistros()) {
      list.push({
        id: `wsl:${distro}`,
        name: `WSL · ${distro}`,
        integrated: false,
        command: 'wsl.exe',
        args: ['-d', distro],
        integration: 'none'
      })
    }
  } else {
    const { sh } = ensureScripts()
    const shell = process.env['SHELL'] ?? '/bin/bash'
    list.push({
      id: 'default',
      name: shell.split('/').pop() ?? shell,
      integrated: true,
      command: shell,
      args: ['--rcfile', sh, '-i'],
      integration: 'bash'
    })
  }

  detected = list
  return list.map(({ command: _c, args: _a, integration: _i, ...info }) => info)
}

export interface ResolvedShell {
  command: string
  args: string[]
  /** 需要注入的额外环境变量（cmd 的 PROMPT） */
  env: Record<string, string>
}

/**
 * 解析出实际 spawn 用的命令。
 * shellId 未指定或已失效时回退到列表第一项（优先 pwsh）。
 */
export function resolveShell(shellId?: string): ResolvedShell {
  detectShells()
  const shell = detected.find((s) => s.id === shellId) ?? detected[0]
  if (!shell?.command) throw new Error('本机未找到可用的本地 shell')

  const env: Record<string, string> = {}
  if (shell.integration === 'cmd') {
    // 用 $P（cmd 在每次渲染提示符时求值的路径码）上报 OSC 7。
    // 注意不能用 %CD%：环境变量在 PROMPT 里不会被展开，会原样输出。
    env['PROMPT'] = '$E]7;file:///$P$E\\$P$G'
  }

  return { command: shell.command, args: shell.args ?? [], env }
}

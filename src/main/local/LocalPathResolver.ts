import { posix, win32 } from 'node:path'
import { queryWslHome } from './wsl.ts'

export type WslDistroProvider = (sessionId: string) => string | undefined
export type WslHomeProvider = (distro: string) => Promise<string>

function assertDistro(distro: string): void {
  if (!distro || distro !== distro.trim() || /[/\\\0-\x1f\x7f]/.test(distro)) {
    throw new Error(`无效的 WSL 发行版名称：${JSON.stringify(distro)}`)
  }
}

/** WSL 文件 IPC 的逻辑路径只能是可无损映射到 UNC 或宿主盘挂载点的 POSIX 绝对路径 */
export function normalizeWslPosixPath(logicalPath: string): string {
  if (
    !logicalPath.startsWith('/') ||
    logicalPath.includes('\0') ||
    logicalPath.includes('\\') ||
    /^[A-Za-z]:/.test(logicalPath) ||
    logicalPath.startsWith('drives://')
  ) {
    throw new Error(`不是有效的 WSL POSIX 绝对路径：${JSON.stringify(logicalPath)}`)
  }
  return posix.normalize(logicalPath)
}

export function wslUncRoot(distro: string): string {
  assertDistro(distro)
  return `\\\\wsl.localhost\\${distro}\\`
}

export function toWslUncPath(distro: string, logicalPath: string): string {
  const normalized = normalizeWslPosixPath(logicalPath)
  const root = wslUncRoot(distro)
  if (normalized === '/') return root
  return root + normalized.slice(1).split('/').join('\\')
}

/**
 * WSL 默认把宿主盘挂在 /mnt/c、/mnt/d…。这些目录不能再经 \\wsl.localhost
 * 访问：路径会变成 Windows → WSL UNC → drvfs → Windows 的回环，readdir 返回 EPERM。
 * 只匹配小写单盘符目录；/mnt/D 和 /mnt/data 仍按普通 Linux 目录走 UNC。
 */
export function wslWindowsMountToNative(logicalPath: string): string | null {
  const normalized = normalizeWslPosixPath(logicalPath)
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(normalized)
  if (!match) return null
  const rest = match[2] ? match[2].split('/').join('\\') : ''
  return `${match[1].toUpperCase()}:\\${rest}`
}

/** fs.realpath 返回的宿主盘路径转回 WSL 面板里的 /mnt/<盘符>；非盘符路径返回 null。 */
export function wslWindowsMountFromNative(nativePath: string): string | null {
  if (!nativePath || nativePath.includes('\0')) return null
  let value = nativePath
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(value)) value = value.slice(4)
  if (!/^[A-Za-z]:[\\/]/.test(value)) return null
  const normalized = win32.normalize(value)
  const drive = normalized[0].toLowerCase()
  const rest = normalized.slice(2).replace(/^\\+/, '')
  if (!rest) return `/mnt/${drive}`
  return normalizeWslPosixPath(`/mnt/${drive}/${rest.split('\\').join('/')}`)
}

/** WSL 的实际 node:fs 路径：宿主盘挂载点走盘符，其余 Linux 路径走当前 distro 的 UNC。 */
export function toWslNativePath(distro: string, logicalPath: string): string {
  assertDistro(distro)
  return wslWindowsMountToNative(logicalPath) ?? toWslUncPath(distro, logicalPath)
}

/** fromNative 的统一入口：盘符与当前 distro 的 UNC 都能转回 POSIX，其他根一律拒绝。 */
export function fromWslNativePath(distro: string, nativePath: string): string {
  assertDistro(distro)
  return wslWindowsMountFromNative(nativePath) ?? fromWslUncPath(distro, nativePath)
}

/** 将当前发行版的 UNC 物理路径转回 renderer 使用的 POSIX；根外路径一律拒绝 */
export function fromWslUncPath(distro: string, nativePath: string): string {
  assertDistro(distro)
  if (!nativePath || nativePath.includes('\0')) throw new Error('无效的 WSL UNC 路径')
  let value = nativePath
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`
  value = win32.normalize(value)

  const roots = [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`]
  const root = roots.find((candidate) => {
    const prefix = value.slice(0, candidate.length)
    return prefix.toLowerCase() === candidate.toLowerCase() &&
      (value.length === candidate.length || value[candidate.length] === '\\')
  })
  if (!root) throw new Error(`路径不属于 WSL 发行版 ${distro}：${nativePath}`)
  const rest = value.slice(root.length).replace(/^\\+/, '')
  if (!rest) return '/'
  return normalizeWslPosixPath(`/${rest.split('\\').join('/')}`)
}

/**
 * sessionId 是 WSL 身份边界：renderer 只传 POSIX，实际 node:fs 路径只在这里转换。
 * home provider 可注入，纯测试不需要启动真实 wsl.exe。
 */
export class LocalPathResolver {
  private readonly distroOf: WslDistroProvider
  private readonly homeOf: WslHomeProvider
  private readonly homeCache = new Map<string, Promise<string>>()

  constructor(distroOf: WslDistroProvider, homeOf: WslHomeProvider = queryWslHome) {
    this.distroOf = distroOf
    this.homeOf = homeOf
  }

  isWsl(sessionId: string): boolean {
    return !!this.distroOf(sessionId)
  }

  toNative(sessionId: string, logicalPath: string): string {
    const distro = this.distroOf(sessionId)
    return distro ? toWslNativePath(distro, logicalPath) : logicalPath
  }

  fromNative(sessionId: string, nativePath: string): string {
    const distro = this.distroOf(sessionId)
    return distro ? fromWslNativePath(distro, nativePath) : nativePath
  }

  home(sessionId: string): Promise<string> {
    const distro = this.distroOf(sessionId)
    if (!distro) throw new Error('该会话不是 WSL，无法查询 WSL home')
    assertDistro(distro)
    let pending = this.homeCache.get(distro)
    if (!pending) {
      pending = this.homeOf(distro).then((home) => normalizeWslPosixPath(home)).catch(() => '/')
      this.homeCache.set(distro, pending)
    }
    return pending
  }
}

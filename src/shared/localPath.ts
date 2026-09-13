/**
 * 本机文件面板的 Windows 路径约定（渲染/主进程共用）。
 *
 * 远端一律 posix（服务器基本是 Linux），只有「本机面板跑在 Windows 上」
 * 才需要这套东西：盘符路径、反斜杠、以及盘符之上那一层合成的「此电脑」。
 */

/** 「此电脑」的哨兵 cwd：真实绝对路径要么是 `X:\` 要么是 `\\`，永远不会长这样 */
export const WIN_DRIVES = 'drives://'

/** 看着像 Windows 绝对路径（`C:\…` / `C:/…`） */
export function isWinPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * 拼子路径。dir 是 Windows 形态就用反斜杠，否则 posix。
 * 调用方保证 dir 非空（面板里 cwd 永远是绝对路径或哨兵）。
 */
export function joinLocal(dir: string, name: string): string {
  if (dir === WIN_DRIVES) return `${name}\\`
  if (isWinPath(dir)) return `${dir.replace(/[\\/]+$/, '')}\\${name}`
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** 父目录。盘符根的父是「此电脑」；posix 根的父还是自己 */
export function parentLocal(dir: string): string {
  if (dir === WIN_DRIVES) return WIN_DRIVES
  if (isWinPath(dir)) {
    const trimmed = dir.replace(/[\\/]+$/, '')
    const i = trimmed.lastIndexOf('\\')
    // `C:` 这一级再往上就是盘符列表
    if (i <= 2) return WIN_DRIVES
    return trimmed.slice(0, i)
  }
  const trimmed = dir.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i)
}

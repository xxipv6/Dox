/**
 * Windows 落盘文件名净化。
 *
 * 远端是 Linux，文件名可以合法地含 `<>:"/\\|?*`、控制字符、以点/空格结尾，
 * 甚至叫 CON/AUX/NUL/COM1 —— 这些名字在 Windows 上 mkdir/写文件直接抛
 * ENOENT/EINVAL，错误原文用户根本看不懂。下载路径的**本机侧**一律过这层；
 * macOS/Linux 原样返回（那边只有 / 和 NUL 非法，SFTP 名字里本来就不可能有）。
 */

// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizeWinName(name: string): string {
  if (process.platform !== 'win32') return name
  let s = name.replace(ILLEGAL, '_').replace(/[. ]+$/, '')
  if (RESERVED.test(s)) s = '_' + s
  return s || '_'
}

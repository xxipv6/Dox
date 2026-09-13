import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { MAX_EDITABLE_BYTES, type FileEntry, type RemoteFileContent } from '../../shared/types'
import { WIN_DRIVES } from '../../shared/localPath'
import { archiveBaseName, withSuffix } from '../sftp/archive'
import { sanitizeWinName } from '../fsSafe'

const execFileP = promisify(execFile)

/**
 * 本机文件操作（本地终端标签的文件面板）。
 *
 * 与 SftpService 的远端/容器两路并列的第三路：同一套面板、同一套 IPC，
 * 主进程按 sessionId 前缀分流到这里。路径是**本机原生形态**（Windows 带
 * 盘符反斜杠），mtime 一律秒（对齐 SFTP 语义，乐观锁比较才不飘）。
 *
 * 红线与远端一致：删除不跟随符号链接；写文本带 mtime 乐观锁；
 * 打包用系统 tar（macOS/Linux/Win10+ 都有），不往系统里装任何东西。
 */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

/** mtime 统一成秒（SFTP 精度）；比较两端都用它才不会 ms 尾数打架 */
const mtimeSec = (st: fs.Stats): number => Math.floor(st.mtimeMs / 1000)

/** 存在的盘符（C-Z）。逐个 existsSync 比调 wmic/PowerShell 快且零依赖 */
async function listDrives(): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const letter = String.fromCharCode(c)
    const root = `${letter}:\\`
    try {
      await fs.promises.access(root)
      out.push({ name: `${letter}:`, path: root, isDir: true, isSymlink: false, size: 0, mtime: 0 })
    } catch {
      /* 盘符不存在 */
    }
  }
  return out
}

export async function list(dir: string): Promise<FileEntry[]> {
  if (process.platform === 'win32' && dir === WIN_DRIVES) return listDrives()
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const p = path.join(dir, d.name)
      // lstat 而不是 stat：符号链接自身的大小/时间，且断链不炸；
      // isDir 只看 dirent（链接到目录也算「文件」，删除时 unlink —— 与远端一致）
      const st = await fs.promises.lstat(p).catch(() => null)
      return {
        name: d.name,
        path: p,
        isDir: d.isDirectory(),
        isSymlink: d.isSymbolicLink(),
        size: st?.size ?? 0,
        mtime: st ? mtimeSec(st) : 0
      }
    })
  )
  // 目录优先，同类按名称排序（与远端口径一致）
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
}

export async function realpath(p: string): Promise<string> {
  // 面板的落地起点：家目录（远端 realpath('.') 的本地对应）
  if (p === '.') return os.homedir()
  return fs.promises.realpath(p)
}

/** 探路径类型（终端 Ctrl+点击的分发依据）。跟随符号链接；不存在返回 null */
export async function stat(p: string): Promise<{ isDir: boolean } | null> {
  try {
    const st = await fs.promises.stat(p)
    return { isDir: st.isDirectory() }
  } catch {
    return null
  }
}

export async function mkdir(p: string): Promise<void> {
  // Windows 保留名/非法字符会在 fs 层炸出 ENOENT/EINVAL 之类看不懂的错，
  // 先过一遍 sanitize 的判定给出人话（sanitizeWinName 非 win 平台原样返回，
  // 所以只在 win32 拦）
  if (process.platform === 'win32') {
    const name = path.basename(p)
    if (sanitizeWinName(name) !== name) throw new Error(`Windows 不允许的名字：${name}`)
  }
  await fs.promises.mkdir(p)
}

export async function rename(from: string, to: string): Promise<void> {
  await fs.promises.rename(from, to)
}

/**
 * 路径所在文件系统的用量。Node ≥18.15 的 fs.statfs；Windows 上 libuv
 * 不支持会抛 ENOSYS —— 用量条是加分项，null 让面板藏起来即可。
 */
export async function diskUsage(p: string): Promise<{ total: number; used: number; avail: number } | null> {
  try {
    const st = await fs.promises.statfs(p)
    const total = Number(st.bsize) * Number(st.blocks)
    const avail = Number(st.bsize) * Number(st.bavail)
    if (!total) return null
    return { total, used: total - Number(st.bsize) * Number(st.bfree), avail }
  } catch {
    return null
  }
}

/** 读文本文件供内置编辑器：先看大小再看内容，NUL 判定二进制（同远端口径） */
export async function readText(p: string): Promise<RemoteFileContent> {
  const st = await fs.promises.stat(p)
  if (st.size > MAX_EDITABLE_BYTES) {
    throw new Error(
      `文件 ${formatSize(st.size)} 超过 ${formatSize(MAX_EDITABLE_BYTES)} 上限，` +
        `无法在内置编辑器中打开。请用系统编辑器查看。`
    )
  }
  const buf = await fs.promises.readFile(p)
  const binary = buf.includes(0)
  return {
    path: p,
    content: binary ? '' : buf.toString('utf8'),
    size: st.size,
    mtime: mtimeSec(st),
    binary
  }
}

/** 写回文本，返回新 mtime（秒）。expectedMtime 不符 = 编辑期间被别处改过，拒写 */
export async function writeText(p: string, content: string, expectedMtime?: number): Promise<number> {
  if (expectedMtime !== undefined) {
    const current = await fs.promises.stat(p).catch(() => null)
    if (current && mtimeSec(current) !== expectedMtime) {
      throw new Error(
        '该文件在你编辑期间已被外部修改。请关闭后重新打开确认最新内容，避免覆盖掉别人的改动。'
      )
    }
  }
  await fs.promises.writeFile(p, content, 'utf8')
  return mtimeSec(await fs.promises.stat(p))
}

/**
 * 删除文件（unlink）或目录（递归）。符号链接一律 unlink 不跟随 ——
 * fs.rm 对链接本身就是 unlink 语义，递归删目录里的链接也不会跟进去。
 */
export async function remove(p: string, isDir: boolean): Promise<void> {
  if (!isDir) {
    await fs.promises.unlink(p)
    return
  }
  await fs.promises.rm(p, { recursive: true })
}

/**
 * 就地打包：当前目录生成 .tar.gz（系统 tar，macOS/Linux/Win10+ 自带）。
 * 撞名避让与远端同规则；execFile 走 argv 不过 shell，没有引号问题。
 */
export async function archive(paths: string[]): Promise<string> {
  if (!paths.length) throw new Error('没有选中任何项')
  const parent = path.dirname(paths[0])
  const names = paths.map((p) => path.basename(p))
  for (const p of paths) {
    if (path.dirname(p) !== parent) throw new Error('只能打包同一目录下的项')
  }
  const base = archiveBaseName(names)
  let target = base
  for (let n = 2; ; n++) {
    if (!fs.existsSync(path.join(parent, target))) break
    target = withSuffix(base, n)
  }
  try {
    // 目标必须给绝对路径：-C 只影响后续文件参数，-f 的相对目标会落在
    // **进程 cwd**（打包后是天知道哪儿），而不是所选目录
    await execFileP('tar', ['-czf', path.join(parent, target), '-C', parent, '--', ...names])
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') throw new Error('系统里没有 tar 命令，无法打包')
    throw err
  }
  return path.join(parent, target)
}

import type { SFTPWrapper } from 'ssh2'
import { MAX_EDITABLE_BYTES, type FileEntry, type RemoteFileContent } from '../../shared/types'
import type { SessionManager } from '../ssh/SessionManager'
import { execCapture } from '../ssh/remoteExec'
import { archiveBaseName, buildArchiveCommand, withSuffix } from './archive'
import {
  mkdirP,
  posix,
  readFileP,
  readdirP,
  rmdirP,
  statP,
  unlinkP,
  writeFileP
} from './sftpUtils'

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

/**
 * SFTP 文件操作。远端一律按 posix 语义处理路径（服务器基本是 Linux），
 * 与本地平台无关。
 */
export class SftpService {
  constructor(private readonly sessions: SessionManager) {}

  async list(sessionId: string, dir: string): Promise<FileEntry[]> {
    const sftp = await this.sessions.sftp(sessionId)
    const items = await readdirP(sftp, dir)
    return items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => ({
        name: i.filename,
        path: posix.join(dir, i.filename),
        isDir: i.attrs.isDirectory(),
        isSymlink: i.attrs.isSymbolicLink(),
        size: i.attrs.size,
        mtime: i.attrs.mtime
      }))
      // 目录优先，同类按名称排序
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  }

  async realpath(sessionId: string, path: string): Promise<string> {
    const sftp = await this.sessions.sftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.realpath(path, (err, resolved) => (err ? reject(err) : resolve(resolved)))
    })
  }

  /**
   * 探一下路径是文件还是目录（终端里 Ctrl+点击路径的「智能分发」用）。
   * 不存在 / 不可读 / 已断开都返回 null —— 终端输出里的路径可能只是长得像，
   * 点开没有结果不算错误，不值得抛给用户。
   */
  async stat(sessionId: string, path: string): Promise<{ isDir: boolean } | null> {
    try {
      const sftp = await this.sessions.sftp(sessionId)
      const attrs = await statP(sftp, path)
      return { isDir: attrs.isDirectory() }
    } catch {
      return null
    }
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const sftp = await this.sessions.sftp(sessionId)
    await mkdirP(sftp, path)
  }

  /**
   * 打包：在远端**当前目录**把选中项打成 .tar.gz，返回包的路径。
   *
   * 不下载、不写本地 —— 下载有专门的入口，这里解决的是「先在远端归置成
   * 一个包」这件事本身（比如要在远端转移、或之后再决定下不下载）。
   *
   * 大目录打包可能远超 execCapture 默认的 10s 上限，给 5 分钟；
   * 期间渲染进程在 await —— 失败会把 tar 的 stderr 原文带回去。
   */
  async archive(sessionId: string, paths: string[]): Promise<string> {
    if (!paths.length) throw new Error('没有选中任何项')
    const parent = posix.dirname(paths[0])
    const names = paths.map((p) => posix.basename(p))
    for (const p of paths) {
      if (posix.dirname(p) !== parent) {
        throw new Error('只能打包同一目录下的项')
      }
    }

    const sftp = await this.sessions.sftp(sessionId)
    const client = this.sessions.getClient(sessionId)
    if (!client) throw new Error('会话已断开，无法打包')

    // 撞名避让：foo.tar.gz → foo-2.tar.gz → …（打包不是覆盖别人文件的理由）
    const base = archiveBaseName(names)
    let target = base
    for (let n = 2; ; n++) {
      try {
        await statP(sftp, posix.join(parent, target))
        target = withSuffix(base, n)
      } catch {
        break
      }
    }

    await execCapture(client, buildArchiveCommand(parent, target, names), {
      timeoutMs: 300_000
    })
    // 打包期间若发生重连，结果已落在旧连接那侧 —— 提示用户刷新确认，别装没事
    if (this.sessions.getClient(sessionId) !== client) {
      throw new Error('打包期间连接发生了变更，请刷新目录确认结果')
    }
    return posix.join(parent, target)
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.sessions.sftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  /**
   * 读取文本文件供内置编辑器显示。
   * 先看大小再看内容：大文件直接拒绝（读进来会卡死渲染进程），
   * 开头 8KB 含 NUL 字节则判定为二进制，不交给编辑器（否则是满屏乱码）。
   */
  async readText(sessionId: string, path: string): Promise<RemoteFileContent> {
    const sftp = await this.sessions.sftp(sessionId)
    const attrs = await statP(sftp, path)

    if (attrs.size > MAX_EDITABLE_BYTES) {
      throw new Error(
        `文件 ${formatSize(attrs.size)} 超过 ${formatSize(MAX_EDITABLE_BYTES)} 上限，` +
          `无法在内置编辑器中打开。请用「下载」后本地查看。`
      )
    }

    // 整个缓冲区扫 NUL（不是只扫开头）：文件已经读进内存了，全量扫描更准，
    // 也能挡掉「前 8KB 恰好没有 NUL 的二进制」
    const buf = await readFileP(sftp, path)
    const binary = buf.includes(0)

    return {
      path,
      content: binary ? '' : buf.toString('utf8'),
      size: attrs.size,
      mtime: attrs.mtime,
      binary
    }
  }

  /**
   * 写回文本文件，返回新的 mtime。
   *
   * expectedMtime 是打开文件时的 mtime：如果远端在此期间被别处改过，
   * 直接覆盖会无声吞掉别人的改动（改配置文件的经典事故），所以这里
   * 拒绝写入，让用户自己决定。
   */
  async writeText(
    sessionId: string,
    path: string,
    content: string,
    expectedMtime?: number
  ): Promise<number> {
    const sftp = await this.sessions.sftp(sessionId)

    if (expectedMtime !== undefined) {
      const current = await statP(sftp, path).catch(() => null)
      if (current && current.mtime !== expectedMtime) {
        throw new Error(
          '该文件在你编辑期间已被外部修改。请关闭后重新打开确认最新内容，' +
            '避免覆盖掉别人的改动。'
        )
      }
    }

    await writeFileP(sftp, path, Buffer.from(content, 'utf8'))
    const attrs = await statP(sftp, path)
    return attrs.mtime
  }

  /**
   * 删除文件（unlink）或目录（递归）。
   * 递归删除是高危操作，渲染进程必须显式确认后才允许调用目录分支。
   * 符号链接一律按文件 unlink，绝不跟随进入。
   */
  async remove(sessionId: string, path: string, isDir: boolean): Promise<void> {
    const sftp = await this.sessions.sftp(sessionId)
    if (!isDir) {
      await unlinkP(sftp, path)
      return
    }
    const items = await readdirP(sftp, path)
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue
      const child = posix.join(path, item.filename)
      if (item.attrs.isSymbolicLink() || !item.attrs.isDirectory()) {
        await unlinkP(sftp, child)
      } else {
        await this.remove(sessionId, child, true)
      }
    }
    await rmdirP(sftp, path)
  }
}

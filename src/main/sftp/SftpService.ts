import type { FileEntry } from '../../shared/types'
import type { SessionManager } from '../ssh/SessionManager'
import { mkdirP, posix, readdirP, rmdirP, unlinkP } from './sftpUtils'

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

  async mkdir(sessionId: string, path: string): Promise<void> {
    const sftp = await this.sessions.sftp(sessionId)
    await mkdirP(sftp, path)
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.sessions.sftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
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

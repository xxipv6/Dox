import fs from 'node:fs'
import { mkdir as mkdirLocal, rm as rmLocal } from 'node:fs/promises'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import {
  MAX_DRAG_BYTES,
  MAX_DRAG_FILES,
  MAX_EDITABLE_BYTES,
  type FileEntry,
  type RemoteFileContent
} from '../../shared/types'
import type { SessionManager } from '../ssh/SessionManager'
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

  /**
   * 正在准备拖出的会话 id。
   *
   * 拖出是「先把远端拉到本地、再交给系统拖动」，拉的过程可能很久（目录要递归），
   * 期间用户完全有理由反悔。这里用一个集合而不是单值：多标签可以同时各拖各的。
   */
  private dragging = new Set<string>()

  /** 用户点了「取消」，中止该会话正在进行的拖出准备 */
  cancelDragOut(sessionId: string): void {
    this.dragging.add(sessionId)
  }

  /** 拖出是否已被取消；调用一次即清标记，免得毒到下一次拖出 */
  private takeDragCanceled(sessionId: string): boolean {
    if (!this.dragging.has(sessionId)) return false
    this.dragging.delete(sessionId)
    return true
  }

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
   * 把远端文件/目录拉到本地临时目录，供「拖出到资源管理器」用。
   *
   * 为什么必须先落盘：`webContents.startDrag` 只认本地文件路径，操作系统
   * 拖放协议要的是一个真实存在的东西。所以「拖出」本质上是「先下载、再拖」，
   * 这一点绕不过去 —— 也因此要挡住超大目标，别让用户拖半天没反应。
   *
   * 返回本地路径；调用方拿它去 startDrag。
   */
  async prepareDragOut(
    sessionId: string,
    remotePath: string,
    fileName: string,
    tempRoot: string
  ): Promise<string> {
    // 开新的一轮：清掉上一轮可能残留的取消标记，否则这次一开始就被判取消
    this.dragging.delete(sessionId)

    const sftp = await this.sessions.sftp(sessionId)
    const attrs = await statP(sftp, remotePath)
    const localPath = join(tempRoot, fileName)
    // 本地建目录用 node:fs —— sftpUtils 里的 mkdirP 是给**远端**用的
    await mkdirLocal(tempRoot, { recursive: true })
    // 上一次可能拖过同名的东西（文件 ↔ 目录），残留会让写入/mkdir 失败
    await rmLocal(localPath, { recursive: true, force: true })

    try {
      if (!attrs.isDirectory()) {
        if (attrs.size > MAX_DRAG_BYTES) {
          throw new Error(
            `「${fileName}」有 ${formatSize(attrs.size)}，超过拖出的 ${formatSize(MAX_DRAG_BYTES)} 上限` +
              `（拖出要先完整下载到本地）。请用行尾的下载按钮。`
          )
        }
        await this.copyToLocal(sessionId, sftp, remotePath, localPath)
        return localPath
      }

      // 目录：先算总量再决定要不要拉，避免拉了一半才发现太大
      const scan = await this.measureRemoteTree(sftp, remotePath)
      if (scan.bytes > MAX_DRAG_BYTES) {
        throw new Error(
          `文件夹「${fileName}」共 ${formatSize(scan.bytes)}（${scan.files} 个文件），` +
            `超过拖出的 ${formatSize(MAX_DRAG_BYTES)} 上限（拖出要先完整下载到本地）。` +
            `请用行尾的下载按钮。`
        )
      }
      if (scan.files > MAX_DRAG_FILES) {
        throw new Error(
          `文件夹「${fileName}」有 ${scan.files} 个文件，超过拖出的 ${MAX_DRAG_FILES} 个上限。` +
            `请用行尾的下载按钮。`
        )
      }

      await this.downloadTree(sessionId, sftp, remotePath, localPath)
      return localPath
    } catch (err) {
      // 取消或失败都不留半截：本地临时目录里堆着不完整的东西，
      // 下次拖同一个名字时更难判断发生了什么
      await rmLocal(localPath, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }

  /**
   * 远端 → 本地的一次拷贝，带取消支持。
   *
   * 不能用 sftp.fastGet：它只在结束时回调，中途既没有进度也无法中止 ——
   * 用户点了取消只能等它自己传完，等于没取消。换成流式拷贝，在数据到达的
   * 边界上检查取消标记。
   */
  private copyToLocal(
    sessionId: string,
    sftp: SFTPWrapper,
    remotePath: string,
    localPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const src = sftp.createReadStream(remotePath)
      const dst = fs.createWriteStream(localPath)
      let failure: Error | null = null

      const abort = (err: Error): void => {
        if (failure) return
        failure = err
        src.destroy()
        dst.destroy()
      }
      src.on('error', abort)
      dst.on('error', abort)
      src.on('data', () => {
        if (failure) return
        if (this.takeDragCanceled(sessionId)) abort(new Error('已取消'))
      })

      /*
       * 只在 dst 的 'close' 上落定，不要在 destroy() 之后立刻 reject。
       * destroy() 只是「开始关闭」，文件句柄要等 close 才真正释放；
       * 在那之前去删这个文件在 Windows 上会 EBUSY，调用方的清理就白做了 ——
       * 表现为「取消了，但临时目录里留了个半截文件」。
       */
      dst.on('close', () => (failure ? reject(failure) : resolve()))
      src.pipe(dst)
    })
  }

  /**
   * 递归统计远端目录的总字节数与文件数。
   *
   * 量小是为了先判断「值不值得拉」——目录拖出没有边拉边回头的机会，
   * 拉到一半发现超限再回滚，用户白等一场。软链接一律跳过，理由同
   * TransferManager.enqueueDownloadDir：跟随软链可能绕出环或逃出目录。
   */
  private async measureRemoteTree(
    sftp: SFTPWrapper,
    root: string
  ): Promise<{ bytes: number; files: number }> {
    let bytes = 0
    let files = 0
    const walk = async (dir: string): Promise<void> => {
      for (const item of await readdirP(sftp, dir)) {
        if (item.filename === '.' || item.filename === '..') continue
        if (item.attrs.isSymbolicLink()) continue
        if (item.attrs.isDirectory()) await walk(posix.join(dir, item.filename))
        else {
          bytes += item.attrs.size
          files += 1
        }
      }
    }
    await walk(root)
    return { bytes, files }
  }

  /** 递归把远端目录拉到本地（拖出用，不进可见的传输队列） */
  private async downloadTree(
    sessionId: string,
    sftp: SFTPWrapper,
    remoteDir: string,
    localDir: string
  ): Promise<void> {
    // 每个文件之间也要查一次：小文件可能在一次 data 事件里就传完了，
    // 只靠 copyToLocal 里那一次检查会让取消拖到下个文件才生效
    if (this.takeDragCanceled(sessionId)) throw new Error('已取消')
    await mkdirLocal(localDir, { recursive: true })
    for (const item of await readdirP(sftp, remoteDir)) {
      if (item.filename === '.' || item.filename === '..') continue
      if (item.attrs.isSymbolicLink()) continue
      const rChild = posix.join(remoteDir, item.filename)
      const lChild = join(localDir, item.filename)
      if (item.attrs.isDirectory()) {
        await this.downloadTree(sessionId, sftp, rChild, lChild)
      } else {
        await this.copyToLocal(sessionId, sftp, rChild, lChild)
      }
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

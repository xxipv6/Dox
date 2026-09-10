import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { basename, join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { TransferDirection, TransferTask } from '../../shared/types'
import { mkdirRemoteRecursive, posix, readdirP, statP, toPosixRel, unlinkP } from './sftpUtils'

const CANCELED = '__transfer_canceled__'
/** 进度事件节流间隔（ms），避免高频 IPC 刷爆渲染进程 */
const EMIT_INTERVAL = 100
/** 已结束任务在内存中保留的上限，防止长时间运行后任务表无界增长 */
const MAX_FINISHED_TASKS = 500

interface InternalTask extends TransferTask {
  _cancel?: () => void
  /**
   * 取消标记。任务在 await getSftp() 期间状态已是 active 但 _cancel 还没挂上，
   * 这期间点取消不能丢 —— 只置位，等 pipe() 开头自己检查。
   */
  _cancelRequested?: boolean
}

interface LocalFileItem {
  path: string
  size: number
  /** 相对被拖入根目录的 posix 相对路径，如 sub/a.txt */
  rel: string
}

/** 递归遍历本地目录，返回所有文件 */
async function walkLocal(root: string): Promise<LocalFileItem[]> {
  const out: LocalFileItem[] = []
  const walk = async (dir: string, relDir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, rel)
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(full)
        out.push({ path: full, size: stat.size, rel })
      }
      // 符号链接等其他类型跳过，避免跟链
    }
  }
  await walk(root, '')
  return out
}

/**
 * 传输队列：流式读写（大文件不占内存）、并发 2、进度节流推送、可取消。
 * 文件夹传输在入队时展开为文件级任务（先建好目录骨架），
 * 取消时尽力删除目标端的半截文件。
 */
export class TransferManager {
  private tasks = new Map<string, InternalTask>()
  private queue: string[] = []
  private activeCount = 0
  private readonly maxConcurrent = 2
  private lastEmitAt = 0
  private emitScheduled = false

  constructor(
    private readonly getSftp: (sessionId: string) => Promise<SFTPWrapper>,
    private readonly onUpdate: (tasks: TransferTask[]) => void
  ) {}

  list(): TransferTask[] {
    return [...this.tasks.values()].map(({ _cancel, ...t }) => t)
  }

  /** 上传本地文件或文件夹（文件夹递归展开），返回创建的任务列表 */
  async enqueueUpload(sessionId: string, localPath: string, remoteDir: string): Promise<TransferTask[]> {
    const stat = await fs.promises.stat(localPath)

    if (stat.isFile()) {
      const task = this.createTask(
        sessionId,
        'upload',
        localPath,
        posix.join(remoteDir, basename(localPath)),
        stat.size
      )
      this.push(task)
      return [this.snapshot(task)]
    }

    if (stat.isDirectory()) {
      const sftp = await this.getSftp(sessionId)
      const rootRemote = posix.join(remoteDir, basename(localPath))
      await mkdirRemoteRecursive(sftp, rootRemote)
      const files = await walkLocal(localPath)
      const created: TransferTask[] = []
      for (const f of files) {
        const remotePath = posix.join(rootRemote, toPosixRel(f.rel))
        await mkdirRemoteRecursive(sftp, posix.dirname(remotePath))
        const task = this.createTask(sessionId, 'upload', f.path, remotePath, f.size, `${basename(localPath)}/${toPosixRel(f.rel)}`)
        this.push(task)
        created.push(this.snapshot(task))
      }
      return created
    }

    return []
  }

  /** 下载远端文件到本地路径 */
  async enqueueDownload(sessionId: string, remotePath: string, localPath: string): Promise<TransferTask> {
    const sftp = await this.getSftp(sessionId)
    const attrs = await statP(sftp, remotePath)
    const task = this.createTask(sessionId, 'download', localPath, remotePath, attrs.size)
    this.push(task)
    return this.snapshot(task)
  }

  /** 下载远端文件夹（递归展开）到本地目录，返回创建的任务列表 */
  async enqueueDownloadDir(sessionId: string, remotePath: string, localDir: string): Promise<TransferTask[]> {
    const sftp = await this.getSftp(sessionId)
    const rootName = posix.basename(remotePath)
    const rootLocal = join(localDir, rootName)
    await fs.promises.mkdir(rootLocal, { recursive: true })

    const created: TransferTask[] = []
    const walk = async (rDir: string, lDir: string, relDir: string): Promise<void> => {
      const items = await readdirP(sftp, rDir)
      for (const item of items) {
        if (item.filename === '.' || item.filename === '..') continue
        const rChild = posix.join(rDir, item.filename)
        const rel = relDir ? `${relDir}/${item.filename}` : item.filename
        if (item.attrs.isSymbolicLink()) continue
        if (item.attrs.isDirectory()) {
          const lChild = join(lDir, item.filename)
          await fs.promises.mkdir(lChild, { recursive: true })
          await walk(rChild, lChild, rel)
        } else {
          const task = this.createTask(
            sessionId,
            'download',
            join(lDir, item.filename),
            rChild,
            item.attrs.size,
            `${rootName}/${rel}`
          )
          this.push(task)
          created.push(this.snapshot(task))
        }
      }
    }
    await walk(remotePath, rootLocal, '')

    // 空目录不会展开出任何文件任务，队列里毫无动静会让用户以为没点成功。
    // 补一条已完成记录代表「目录本身已创建」。
    if (created.length === 0) {
      const task = this.createTask(sessionId, 'download', rootLocal, remotePath, 0, `${rootName}/`)
      task.status = 'done'
      this.emit()
      return [this.snapshot(task)]
    }
    return created
  }

  cancel(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status === 'pending') {
      // pump 会跳过非 pending 项，无需从 queue 移除
      task.status = 'canceled'
      this.emit()
    } else if (task.status === 'active') {
      task._cancelRequested = true
      task._cancel?.()
    }
  }

  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === 'done' || task.status === 'error' || task.status === 'canceled') {
        this.tasks.delete(id)
      }
    }
    this.emit()
  }

  private createTask(
    sessionId: string,
    direction: TransferDirection,
    localPath: string,
    remotePath: string,
    size: number,
    displayName?: string
  ): InternalTask {
    const task: InternalTask = {
      id: randomUUID(),
      sessionId,
      direction,
      localPath,
      remotePath,
      fileName: displayName ?? basename(localPath),
      size,
      transferred: 0,
      status: 'pending'
    }
    this.tasks.set(task.id, task)
    this.pruneFinished()
    return task
  }

  /** 任务表超限时按插入顺序丢最老的已结束任务（Map 保持插入序） */
  private pruneFinished(): void {
    let finished = 0
    for (const task of this.tasks.values()) {
      if (task.status === 'done' || task.status === 'error' || task.status === 'canceled') finished++
    }
    let excess = finished - MAX_FINISHED_TASKS
    if (excess <= 0) return
    for (const [id, task] of this.tasks) {
      if (excess <= 0) break
      if (task.status === 'done' || task.status === 'error' || task.status === 'canceled') {
        this.tasks.delete(id)
        excess--
      }
    }
  }

  private push(task: InternalTask): void {
    this.queue.push(task.id)
    // 用合并广播：目录展开时每个文件都会 push，若每次都全量广播，
    // N 个文件会产生 O(N²) 次结构化克隆（5000 文件即千万级），
    // 主进程与渲染进程同时卡死、所有 IPC 停摆
    this.scheduleEmit()
    void this.pump()
  }

  private scheduleEmit(): void {
    if (this.emitScheduled) return
    this.emitScheduled = true
    queueMicrotask(() => {
      this.emitScheduled = false
      this.emit()
    })
  }

  private snapshot(task: InternalTask): TransferTask {
    const { _cancel, ...t } = task
    return t
  }

  private async pump(): Promise<void> {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!
      const task = this.tasks.get(id)
      if (!task || task.status !== 'pending') continue
      this.activeCount++
      void this.run(task).finally(() => {
        this.activeCount--
        this.emit()
        void this.pump()
      })
    }
  }

  private async run(task: InternalTask): Promise<void> {
    task.status = 'active'
    this.emit()
    try {
      const sftp = await this.getSftp(task.sessionId)
      await this.pipe(task, sftp)
      task.status = 'done'
      task.transferred = task.size
    } catch (err) {
      const e = err as Error
      if (e.message === CANCELED) {
        task.status = 'canceled'
      } else {
        task.status = 'error'
        task.error = e.message
      }
    }
    this.emit()
  }

  private pipe(task: InternalTask, sftp: SFTPWrapper): Promise<void> {
    return new Promise((resolve, reject) => {
      // getSftp 期间被取消：那时 _cancel 还没挂上，这里补一次
      if (task._cancelRequested) {
        reject(new Error(CANCELED))
        return
      }
      const isUpload = task.direction === 'upload'
      const src = isUpload
        ? fs.createReadStream(task.localPath)
        : sftp.createReadStream(task.remotePath)
      const dst = isUpload
        ? sftp.createWriteStream(task.remotePath)
        : fs.createWriteStream(task.localPath)

      const fail = (err: Error): void => {
        src.destroy()
        dst.destroy()
        reject(err)
      }
      src.on('error', fail)
      dst.on('error', fail)
      src.on('data', (chunk: Buffer | string) => {
        task.transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        this.emitThrottled()
      })
      dst.on('close', () => resolve())

      task._cancel = () => {
        src.destroy()
        dst.destroy()
        // 清理半截文件（尽力而为）
        if (isUpload) void unlinkP(sftp, task.remotePath).catch(() => undefined)
        else void fs.promises.unlink(task.localPath).catch(() => undefined)
        reject(new Error(CANCELED))
      }

      src.pipe(dst)
    })
  }

  private emitThrottled(): void {
    const now = Date.now()
    if (now - this.lastEmitAt >= EMIT_INTERVAL) {
      this.lastEmitAt = now
      this.emit()
    }
  }

  private emit(): void {
    this.onUpdate(this.list())
  }
}

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

/**
 * 成功 / 被取消的任务在界面上再留多久，然后自己消失（ms）。
 *
 * 传完之后那一条会一直挂在队列里，用户得手动点「清除已完成」才能收掉 ——
 * 而队列现在会占掉底部一条高度，越攒越挤。留几秒是给用户一个「传完了」的
 * 确认窗口，过了就自动走。
 *
 * 失败的任务**不自动消失**：错误得留着让人看见并处理，悄悄收掉等于没报错。
 */
const AUTO_DISMISS_MS = 3000

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

/**
 * 递归遍历本地目录，返回所有文件。
 *
 * isCanceled 每轮都要问一次：上传文件夹时本地遍历可能也要好几秒，
 * 用户点了「全部取消」不该等它遍历完。
 */
async function walkLocal(root: string, isCanceled: () => boolean): Promise<LocalFileItem[]> {
  const out: LocalFileItem[] = []
  const walk = async (dir: string, relDir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (isCanceled()) return
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
  /** taskId → 自动消失定时器，任务被提前移除时要顺手清掉 */
  private dismissTimers = new Map<string, NodeJS.Timeout>()
  /**
   * 中断正在进行的目录展开。
   *
   * 传文件夹时任务是一条条「边遍历边入队」的：遍历一个几千文件的目录要好几秒，
   * 这期间新任务持续冒出来。只把当前这批取消掉没有意义 —— 遍历还在跑，
   * 下一秒又是几十条新的，用户看到的就是「怎么取消都取消不掉」。
   */
  private stopExpansion = false

  constructor(
    private readonly getSftp: (sessionId: string) => Promise<SFTPWrapper>,
    private readonly onUpdate: (tasks: TransferTask[]) => void
  ) {}

  list(): TransferTask[] {
    return [...this.tasks.values()].map(({ _cancel, ...t }) => t)
  }

  /** 上传本地文件或文件夹（文件夹递归展开），返回创建的任务列表 */
  async enqueueUpload(sessionId: string, localPath: string, remoteDir: string): Promise<TransferTask[]> {
    // 新一轮开始：清掉上一次「全部取消」留下的中断标记，否则这次一进去就停
    this.stopExpansion = false
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
      const files = await walkLocal(localPath, () => this.stopExpansion)
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
    // 同 enqueueUpload：新任务必须能重新开始
    this.stopExpansion = false
    const sftp = await this.getSftp(sessionId)
    const rootName = posix.basename(remotePath)
    const rootLocal = join(localDir, rootName)
    await fs.promises.mkdir(rootLocal, { recursive: true })

    const created: TransferTask[] = []
    const walk = async (rDir: string, lDir: string, relDir: string): Promise<void> => {
      const items = await readdirP(sftp, rDir)
      for (const item of items) {
        // 用户点了「全部取消」：停在这，已建的任务由 cancelAll 负责收
        if (this.stopExpansion) return
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
      this.settle(task, 'done')
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
      this.settle(task, 'canceled')
    } else if (task.status === 'active') {
      task._cancelRequested = true
      task._cancel?.()
    }
  }

  /**
   * 全部取消：停掉所有排队/进行中的任务，并中断还在跑的目录展开。
   *
   * 传文件夹时队列里会有成百上千条，一条条点取消既点不完也点不过来；
   * 而且只要遍历没停，取消掉的总会被新冒出来的补上。
   */
  cancelAll(): void {
    this.stopExpansion = true
    for (const task of this.tasks.values()) {
      if (task.status === 'pending') {
        this.settle(task, 'canceled')
      } else if (task.status === 'active') {
        task._cancelRequested = true
        task._cancel?.()
      }
    }
    this.emit()
  }

  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === 'done' || task.status === 'error' || task.status === 'canceled') {
        this.remove(id)
      }
    }
    this.emit()
  }

  /**
   * 任务落定。done / canceled 会排一次自动消失，error 留着不动
   * （错误必须留在界面上让人看见，见 AUTO_DISMISS_MS 的说明）。
   */
  private settle(task: InternalTask, status: 'done' | 'error' | 'canceled'): void {
    task.status = status
    if (status === 'error') return
    const id = task.id
    const timer = setTimeout(() => {
      this.dismissTimers.delete(id)
      // 期间可能已被 clearFinished 或用户重传顶掉
      if (this.tasks.has(id)) {
        this.tasks.delete(id)
        this.emit()
      }
    }, AUTO_DISMISS_MS)
    // 不拖住进程退出
    timer.unref?.()
    this.dismissTimers.set(id, timer)
  }

  /** 移除任务，连同它的自动消失定时器 */
  private remove(id: string): void {
    const timer = this.dismissTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.dismissTimers.delete(id)
    }
    this.tasks.delete(id)
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
        this.remove(id)
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
      task.transferred = task.size
      this.settle(task, 'done')
    } catch (err) {
      const e = err as Error
      if (e.message === CANCELED) {
        this.settle(task, 'canceled')
      } else {
        task.error = e.message
        this.settle(task, 'error')
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

      let failure: Error | null = null
      /** 取消/出错后要做的收尾，等 dst 真正关闭再执行（见下面 close 的说明） */
      let cleanup: (() => void) | null = null

      const abort = (err: Error, after?: () => void): void => {
        if (failure) return
        failure = err
        cleanup = after ?? null
        src.destroy()
        dst.destroy()
      }
      src.on('error', abort)
      dst.on('error', abort)
      src.on('data', (chunk: Buffer | string) => {
        task.transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        this.emitThrottled()
      })

      /*
       * 落定与清理都只在这里做。
       * destroy() 只是「开始关闭」，文件句柄要等 'close' 才释放；之前在
       * _cancel 里 destroy() 完立刻 unlink，是在和句柄释放赛跑 —— Windows 上
       * 会 EBUSY 而这个失败被 catch 吞掉，结果是「取消了，本地却留个半截文件」。
       */
      dst.on('close', () => {
        if (failure) {
          cleanup?.()
          reject(failure)
        } else {
          resolve()
        }
      })

      task._cancel = () => {
        abort(
          new Error(CANCELED),
          // 半截文件：上传删远端、下载删本地，都放在句柄释放之后
          isUpload
            ? (): void => void unlinkP(sftp, task.remotePath).catch(() => undefined)
            : (): void => void fs.promises.unlink(task.localPath).catch(() => undefined)
        )
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

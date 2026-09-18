import { randomUUID } from 'node:crypto'
// 显式 .ts 后缀：验证脚本用 Node 24 type stripping 直接 import 本模块（无打包器补扩展名）
import { sanitizeWinName } from '../fsSafe.ts'
import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
// 默认导入而不是命名导入：Node 原生 ESM 探不出 CJS 包的命名导出
// （verify 脚本用 type stripping 直接 import 本模块），打包器两种都行
import ssh2 from 'ssh2'
import type { TransferDirection, TransferTask } from '../../shared/types'
import type { AgentStreamIO } from '../agent/agentStream'
import { mkdirRemoteRecursive, posix, readdirP, statP, toPosixRel, unlinkP } from './sftpUtils.ts'
import { execCapture, execStream } from '../ssh/remoteExec.ts'
import { firstLine } from '../execError.ts'
import {
  TarParser,
  safeLocalJoin,
  tarEntryBytes,
  tarHeaderBlocks,
  tarPadSize,
  tarTrailer,
  type TarSink
} from './tarStream.ts'

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
  /** 容器传输：SFTP 段之前/之后接的第二段（docker cp），以及中转清理 */
  _prepare?: () => Promise<void>
  _finalize?: () => Promise<void>
  _cleanupStage?: () => void
  /**
   * 容器直传（agent ≥0.4.0 分块流式）：给了它就不走 SFTP pipe，
   * prepare/finalize/stage 全不需要 —— 没有宿主机中转这回事了。
   */
  _stream?: (task: InternalTask) => Promise<void>
}

/**
 * 剥掉内部字段（`_` 前缀）后的任务快照。
 *
 * 内部字段全是函数（取消/容器传输钩子），结构化克隆序列化不了 ——
 * 带着它们广播或做 invoke 返回值就是 "Failed to serialize arguments"。
 * 按前缀剥而不是逐字段列：以后再加内部字段不会重蹈覆辙。
 */
function publicTask(task: InternalTask): TransferTask {
  return Object.fromEntries(Object.entries(task).filter(([k]) => !k.startsWith('_'))) as TransferTask
}

/** P2P 直传预备产物：A 上的私钥路径 + B 上 authorized_keys 的标记 + 拼好的 ssh 命令头 */
interface P2PSession {
  keyPath: string
  marker: string
  sshBase: string
}

/** 容器传输 IO：docker cp 段 + 容器内目录操作（经 agent fs 协议） */
export interface ContainerIO {
  cp(from: string, to: string): Promise<void>
  rmHostStage(path: string): Promise<void>
  /** 容器内递归建目录（agent fs_mkdir） */
  mkdirContainer(dir: string): Promise<void>
  /** 容器内 stat（agent fs_stat） */
  statContainer(path: string): Promise<{ isDir: boolean; size: number }>
  /** 容器内列目录（agent fs_list，下载文件夹时递归展开用） */
  listContainer(dir: string): Promise<{ name: string; isDir: boolean; isSymlink: boolean; size: number }[]>
  /** agent ≥0.4.0 的分块直传（有它就不走 docker cp 接力；见 agent/agentStream.ts） */
  stream?: AgentStreamIO
}

interface LocalFileItem {
  path: string
  size: number
  /** 相对被拖入根目录的 posix 相对路径，如 sub/a.txt */
  rel: string
}

/** shell 单引号转义（远端 exec 命令拼路径用） */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** tar 上传要走的本地条目（目录 + 文件，按遍历序） */
interface LocalTarEntry {
  /** 本机绝对路径 */
  path: string
  /** tar 内的 posix 路径（目录以 '/' 结尾） */
  name: string
  size: number
  mode: number
  /** 秒级 mtime */
  mtime: number
  isDir: boolean
}

/** 撞名避让：a.txt → a-2.txt → a-3.txt（本机复制不覆盖已存在的东西） */
function bumpCopyName(dir: string, name: string): string {
  if (!fs.existsSync(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!fs.existsSync(join(dir, candidate))) return candidate
  }
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
 * 传输队列：流式读写（大文件不占内存）、并发 8、进度节流推送、可取消。
 *
 * 文件夹传输两条路：
 *  - 远端有 tar（几乎必有）：整棵树打成**一条 tar 流**经 exec 通道灌过去
 *   （下载反之），每文件 0 次往返 —— 5 万小文件从「10 万次 RTT」变成
 *   跑满通道窗口，是数量级差距。队列里只有一条任务，进度精确到字节。
 *  - 远端没 tar：回退逐文件展开入队（先建好目录骨架），
 *    取消时尽力删除目标端的半截文件。
 */
export class TransferManager {
  private tasks = new Map<string, InternalTask>()
  private queue: string[] = []
  private activeCount = 0
  /*
   * 并发 8：SFTP 跑在单条 SSH 连接的子系统上，多文件并发与 sshd 的
   * MaxSessions 无关，只多吃几条通道。并发的收益是藏 open/close 小往返，
   * 8 对「小文件多 + 高延迟」够用；再高会被单线程加密 CPU 和交互终端
   * 的体感反超。大批量文件夹走 tar 流，不吃这个数。
   */
  private readonly maxConcurrent = 8
  private lastEmitAt = 0
  private emitScheduled = false
  /** taskId → 自动消失定时器，任务被提前移除时要顺手清掉 */
  private dismissTimers = new Map<string, NodeJS.Timeout>()
  /** sessionId → 远端是否有 tar（探测一次缓存全程） */
  private tarSupport = new Map<string, boolean>()
  /**
   * 中断正在进行的目录展开。
   *
   * 传文件夹时任务是一条条「边遍历边入队」的：遍历一个几千文件的目录要好几秒，
   * 这期间新任务持续冒出来。只把当前这批取消掉没有意义 —— 遍历还在跑，
   * 下一秒又是几十条新的，用户看到的就是「怎么取消都取消不掉」。
   */
  /*
   * 世代计数而不是布尔：并发展开多个目录时，cancelAll 只作废「此刻在跑的」
   * （gen 变化 → 旧展开自动停），后到的 enqueue 不再误复位别人的中断标记。
   */
  private expansionGen = 0

  constructor(
    private readonly getSftp: (sessionId: string) => Promise<SFTPWrapper>,
    private readonly onUpdate: (tasks: TransferTask[]) => void,
    /** tar 流的 exec 通道要从连接上开；拿不到（已断开）就走不了 tar 路 */
    private readonly getClient: (sessionId: string) => Client | undefined
  ) {}

  list(): TransferTask[] {
    return [...this.tasks.values()].map((t) => publicTask(t))
  }

  /**
   * 远端有没有 tar（决定文件夹走整流还是逐文件回退）。
   * `command -v` 是 POSIX 内建，BusyBox 的 sh 也认；探测结果按会话缓存。
   */
  private async supportsTar(sessionId: string): Promise<boolean> {
    const cached = this.tarSupport.get(sessionId)
    if (cached !== undefined) return cached
    const client = this.getClient(sessionId)
    // 拿不到连接时别缓存 false：那会赶在重连前探过一次，整段会话都被判成「没 tar」
    if (!client) return false
    let ok = false
    try {
      await execCapture(client, 'command -v tar', { timeoutMs: 5000 })
      ok = true
    } catch {
      ok = false
    }
    this.tarSupport.set(sessionId, ok)
    return ok
  }

  /** 上传本地文件或文件夹（文件夹递归展开），返回创建的任务列表 */
  async enqueueUpload(sessionId: string, localPath: string, remoteDir: string): Promise<TransferTask[]> {
    const gen = this.expansionGen
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
      const rootName = basename(localPath)
      // tar 整流：一条任务、一条流，免去逐文件的 open/close 往返
      if (await this.supportsTar(sessionId)) {
        const sftp = await this.getSftp(sessionId)
        // tar -C 要求目标目录已存在
        await mkdirRemoteRecursive(sftp, remoteDir)
        const entries: LocalTarEntry[] = []
        const completed = await this.walkTarLocal(localPath, rootName, entries, () => this.expansionGen !== gen)
        if (!completed || this.expansionGen !== gen) return []
        let total = tarTrailer().length
        let fileCount = 0
        for (const e of entries) {
          total += tarEntryBytes(e)
          if (!e.isDir) fileCount++
        }
        const task = this.createTask(
          sessionId,
          'upload',
          localPath,
          posix.join(remoteDir, rootName),
          total,
          `${rootName}/（${fileCount} 个文件，整流模式）`
        )
        task._stream = (t) => this.tarUpload(t, entries, remoteDir)
        this.push(task)
        return [this.snapshot(task)]
      }

      // 回退：逐文件展开入队
      const sftp = await this.getSftp(sessionId)
      const rootRemote = posix.join(remoteDir, rootName)
      // 同树批量建目录：缓存已建层级，否则 N 文件 × 路径深度 次串行 RTT
      const createdDirs = new Set<string>()
      await mkdirRemoteRecursive(sftp, rootRemote, createdDirs)
      const files = await walkLocal(localPath, () => this.expansionGen !== gen)
      const created: TransferTask[] = []
      for (const f of files) {
        // 全部取消后遍历虽停，已遍历出的文件也不能再入队
        if (this.expansionGen !== gen) break
        const remotePath = posix.join(rootRemote, toPosixRel(f.rel))
        await mkdirRemoteRecursive(sftp, posix.dirname(remotePath), createdDirs)
        const task = this.createTask(sessionId, 'upload', f.path, remotePath, f.size, `${rootName}/${toPosixRel(f.rel)}`)
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
    const gen = this.expansionGen
    const rootName = sanitizeWinName(posix.basename(remotePath))
    const rootLocal = join(localDir, rootName)

    // tar 整流：远端边打包边发，本地边收边解（单条任务）
    if (await this.supportsTar(sessionId)) {
      await fs.promises.mkdir(rootLocal, { recursive: true })
      // 百分比需要总量：du -sb（GNU）一趟拿表观字节数；busybox 没有就
      // 只显示已接收字节，不为总量再付一遍遍历
      let total = 0
      const client = this.getClient(sessionId)
      if (client) {
        try {
          const r = await execCapture(client, `du -sb ${shQuote(remotePath)}`, { timeoutMs: 60_000 })
          total = parseInt(r.stdout.trim().split(/\s/)[0], 10) || 0
        } catch {
          total = 0
        }
      }
      const task = this.createTask(sessionId, 'download', rootLocal, remotePath, total, `${rootName}/（整流模式）`)
      task._stream = (t) => this.tarDownload(t, remotePath, localDir)
      this.push(task)
      return [this.snapshot(task)]
    }

    // 回退：逐文件递归展开
    const sftp = await this.getSftp(sessionId)
    await fs.promises.mkdir(rootLocal, { recursive: true })

    const created: TransferTask[] = []
    const walk = async (rDir: string, lDir: string, relDir: string): Promise<void> => {
      const items = await readdirP(sftp, rDir)
      const subdirs: Array<{ rChild: string; lChild: string; rel: string }> = []
      for (const item of items) {
        // 用户点了「全部取消」：停在这，已建的任务由 cancelAll 负责收
        if (this.expansionGen !== gen) return
        if (item.filename === '.' || item.filename === '..') continue
        const rChild = posix.join(rDir, item.filename)
        const rel = relDir ? `${relDir}/${item.filename}` : item.filename
        if (item.attrs.isSymbolicLink()) continue
        if (item.attrs.isDirectory()) {
          const lChild = join(lDir, sanitizeWinName(item.filename))
          await fs.promises.mkdir(lChild, { recursive: true })
          subdirs.push({ rChild, lChild, rel })
        } else {
          const task = this.createTask(
            sessionId,
            'download',
            join(lDir, sanitizeWinName(item.filename)),
            rChild,
            item.attrs.size,
            `${rootName}/${rel}`
          )
          this.push(task)
          created.push(this.snapshot(task))
        }
      }
      // 兄弟目录 8 路并发展开：readdir 每个一次 RTT，串行 DFS 在宽目录树
      // 下是纯「目录数 × RTT」的等待（更深处的目录仍各自并发，8 是总量级）
      for (let i = 0; i < subdirs.length && this.expansionGen === gen; i += 8) {
        await Promise.all(subdirs.slice(i, i + 8).map((d) => walk(d.rChild, d.lChild, d.rel)))
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

  // ---- 本机复制（本地终端文件面板的「复制到… / 拖进来」）----

  /**
   * 本机到本机的复制。走与 SFTP 传输同一个队列：并发、进度、取消、
   * 半截文件清理全复用；direction 沿用 'upload'（remotePath = 落地路径），
   * 面板「传完自动刷新」因此零改动生效。
   *
   * 与远端上传的两个语义差别：
   *  - 撞名避让而不是覆盖 —— 本机已存在的文件不是「旧版本」而是「别人的东西」；
   *  - 拒绝把目录复制进它自己（walkLocal 会一边遍历一边长出新的自己）。
   */
  async enqueueLocalCopy(sessionId: string, sources: string[], destDir: string): Promise<TransferTask[]> {
    const gen = this.expansionGen
    const created: TransferTask[] = []
    const destReal = await fs.promises.realpath(destDir).catch(() => destDir)

    const attachStream = (task: InternalTask): void => {
      task._stream = (t) =>
        this.pipeStreams(
          t,
          fs.createReadStream(t.localPath, { highWaterMark: 256 * 1024 }),
          // 本机复制没有网络栈兜底，写侧默认 16KB 会把 syscall 数放大 64 倍
          fs.createWriteStream(t.remotePath, { highWaterMark: 1024 * 1024 }),
          () => void fs.promises.unlink(t.remotePath).catch(() => undefined)
        )
    }

    for (const src of sources) {
      const st = await fs.promises.lstat(src).catch(() => null)
      // 符号链接跳过：跟链复制会把链接目标的内容抄一份，与 walkLocal 口径一致
      if (!st || st.isSymbolicLink()) continue
      const srcReal = await fs.promises.realpath(src).catch(() => src)
      if (srcReal === destReal || destReal.startsWith(srcReal + sep)) {
        throw new Error(`不能把「${basename(src)}」复制到它自己里面`)
      }

      if (st.isFile()) {
        const task = this.createTask(
          sessionId,
          'upload',
          src,
          join(destDir, bumpCopyName(destDir, basename(src))),
          st.size
        )
        attachStream(task)
        this.push(task)
        created.push(this.snapshot(task))
        continue
      }

      if (st.isDirectory()) {
        const rootName = bumpCopyName(destDir, basename(src))
        const rootDst = join(destDir, rootName)
        await fs.promises.mkdir(rootDst, { recursive: true })
        const files = await walkLocal(src, () => this.expansionGen !== gen)
        for (const f of files) {
          // 全部取消后已遍历出的文件不再入队
          if (this.expansionGen !== gen) break
          const dst = join(rootDst, ...f.rel.split('/'))
          await fs.promises.mkdir(dirname(dst), { recursive: true })
          const task = this.createTask(sessionId, 'upload', f.path, dst, f.size, `${rootName}/${f.rel}`)
          attachStream(task)
          this.push(task)
          created.push(this.snapshot(task))
        }
      }
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

  // ---- 服务器互传（A 远端 → B 远端）----

  /**
   * 把 srcSession 上的若干路径复制到 dstSession 的 dstDir。三级路线，自动选：
   *
   *  1. **同一台机器**（machine-id 相同）：服务端 `cp -a`，零网络流量 ——
   *     两个标签开同一台机器时跨面板粘贴就走这条。
   *  2. **P2P 直传**（opts.p2pTarget 给了 = 用户已授权 + 目标是直连地址）：
   *     一次性 ed25519 密钥对，公钥临时写 B 的 authorized_keys（带标记行）、
   *     私钥临时放 A 的 /tmp（600），A 上 `tar | ssh` 直连 B 满速，
   *     传完两边都删。预飞失败（A 连不到 B）自动落回中继。
   *  3. **中继**：A 的 tar stdout → 本机 → B 的 tar stdin（两端都有 tar），
   *     或 SFTP 逐文件中继。永远能用，但流量过一遍本机。
   *
   * 任务 direction 记 'upload'、sessionId 记**目的端**：目标面板的
   * 「传完自动刷新」（isMyUpload 按 direction+remotePath 判）零改动生效。
   */
  async enqueueServerCopy(
    srcSessionId: string,
    paths: string[],
    dstSessionId: string,
    dstDir: string,
    opts?: { p2pTarget?: { host: string; port: number; username: string }; skipSameMachineCheck?: boolean }
  ): Promise<TransferTask[]> {
    const gen = this.expansionGen
    const dstSftp = await this.getSftp(dstSessionId)
    await mkdirRemoteRecursive(dstSftp, dstDir)

    // 按源父目录分组（tar -C 只接受一个基准目录；cp/P2P 也复用这个分组出任务）
    const groups = new Map<string, string[]>()
    for (const p of paths) {
      const parent = posix.dirname(p)
      const arr = groups.get(parent) ?? []
      arr.push(posix.basename(p))
      groups.set(parent, arr)
    }

    /**
     * 「复制进自己」守卫：**只在确认同台**（或同一连接的安全网）时套用。
     * A 的 /www 复制到 B 的 /www/backup 是完全合法的跨机操作，文本前缀判断
     * 不能越权拦 —— 两边是不同的命名空间。
     */
    const guardSelfCopy = (): void => {
      for (const p of paths) {
        if (dstDir === p || dstDir.startsWith(p.endsWith('/') ? p : `${p}/`)) {
          throw new Error(`不能把「${posix.basename(p)}」复制到它自己里面`)
        }
      }
    }

    /** du 总量（失败就 0，只影响百分比）：du -sk 两族通吃（busybox 没有 -b），×1024 估算 */
    const duTotal = async (parent: string, names: string[]): Promise<number> => {
      const client = this.getClient(srcSessionId)
      if (!client) return 0
      try {
        const fullPaths = names.map((n) => shQuote(posix.join(parent, n))).join(' ')
        const r = await execCapture(
          client,
          `du -sk -- ${fullPaths} 2>/dev/null | awk '{s+=$1} END {print s*1024}'`,
          { timeoutMs: 60_000 }
        )
        return parseInt(r.stdout.trim(), 10) || 0
      } catch {
        return 0
      }
    }

    // ---- 第 1 级：同一台机器 → cp -a ----
    if (!opts?.skipSameMachineCheck) {
      const [srcMid, dstMid] = await Promise.all([
        this.machineId(srcSessionId),
        this.machineId(dstSessionId)
      ])
      if ((srcMid && dstMid && srcMid === dstMid) || srcSessionId === dstSessionId) {
        guardSelfCopy()
        const created: TransferTask[] = []
        for (const [parent, names] of groups) {
          if (this.expansionGen !== gen) break
          const total = await duTotal(parent, names)
          const display =
            names.length === 1 ? `${names[0]}（同台直连）` : `${names[0]} 等 ${names.length} 项（同台直连）`
          const task = this.createTask(
            dstSessionId,
            'upload',
            `${srcSessionId}:${parent}`,
            posix.join(dstDir, names[0]),
            total,
            display
          )
          task._stream = (t) => this.cpWithin(t, srcSessionId, parent, names, dstDir)
          if (this.pushIfCurrent(task, gen)) created.push(this.snapshot(task))
        }
        return created
      }
    }

    // ---- 第 2/3 级：tar 可用时按组出任务（每组内 P2P 优先、中继兜底）----
    const useTar =
      (await this.supportsTar(srcSessionId)) && (await this.supportsTar(dstSessionId))

    if (useTar) {
      const created: TransferTask[] = []
      for (const [parent, names] of groups) {
        if (this.expansionGen !== gen) break
        const total = await duTotal(parent, names)
        const display =
          names.length === 1 ? `${names[0]}（互传整流）` : `${names[0]} 等 ${names.length} 项（互传整流）`
        const task = this.createTask(
          dstSessionId,
          'upload',
          `${srcSessionId}:${parent}`,
          posix.join(dstDir, names[0]),
          total,
          display
        )
        const p2pTarget = opts?.p2pTarget
        task._stream = async (t) => {
          // P2P：预飞不过（拿不到 key/连不通）安静落回中继；传一半失败才报错
          const p2p = p2pTarget ? await this.prepareP2p(srcSessionId, dstSessionId, p2pTarget) : null
          // 预备期间（最坏 ~40s 的多个 await）用户点了取消：收尾后立即落定，
          // 别带着「已取消」标记继续发起传输
          if (t._cancelRequested) {
            if (p2p) await this.cleanupP2p(srcSessionId, dstSessionId, p2p)
            throw new Error(CANCELED)
          }
          // 路线定了就把任务名换成真实路线，界面看得见走了哪条路
          const base = t.fileName.replace(/（互传整流）$/, '')
          t.fileName = `${base}（${p2p ? 'P2P 直传' : '互传中继'}）`
          this.emit()
          if (p2p) {
            try {
              await this.p2pCopy(t, srcSessionId, p2p, parent, names, dstDir)
              return
            } finally {
              await this.cleanupP2p(srcSessionId, dstSessionId, p2p)
            }
          }
          await this.tarRelay(t, srcSessionId, parent, names, dstDir)
        }
        if (this.pushIfCurrent(task, gen)) created.push(this.snapshot(task))
      }
      return created
    }

    // ---- 无 tar 慢路：逐文件 SFTP 中继（源端递归展开目录，目的端建骨架）----
    const srcSftp = await this.getSftp(srcSessionId)
    const created: TransferTask[] = []
    const createdDirs = new Set<string>()

    const walk = async (rPath: string, rel: string): Promise<void> => {
      if (this.expansionGen !== gen) return
      const st = await statP(srcSftp, rPath)
      if (st.isSymbolicLink()) return // 与下载目录同一口径：不跟链
      if (!st.isDirectory()) {
        const dstPath = posix.join(dstDir, rel)
        await mkdirRemoteRecursive(dstSftp, posix.dirname(dstPath), createdDirs)
        const task = this.createTask(dstSessionId, 'upload', rPath, dstPath, st.size, rel)
        task._stream = (t) => this.fileRelay(t, srcSessionId)
        if (this.pushIfCurrent(task, gen)) created.push(this.snapshot(task))
        return
      }
      // 目录本身也要在目的端建出来（空目录不落空）
      await mkdirRemoteRecursive(dstSftp, posix.join(dstDir, rel), createdDirs)
      const items = await readdirP(srcSftp, rPath)
      const children: Array<{ rChild: string; rel: string }> = []
      for (const item of items) {
        if (item.filename === '.' || item.filename === '..') continue
        children.push({ rChild: posix.join(rPath, item.filename), rel: `${rel}/${item.filename}` })
      }
      // 兄弟条目 8 路并发：readdir/stat 每个一次 RTT，宽目录树下串行是纯等待
      for (let i = 0; i < children.length && this.expansionGen === gen; i += 8) {
        await Promise.all(children.slice(i, i + 8).map((c) => walk(c.rChild, c.rel)))
      }
    }

    for (const p of paths) {
      if (this.expansionGen !== gen) break
      await walk(p, posix.basename(p))
    }
    return created
  }

  /** sessionId → machine 标识（互传同台检测；探测一次缓存全程，空串=没探到也缓存防反复 exec） */
  private machineIds = new Map<string, string>()

  /**
   * 同台判定的标识：machine-id + boot_id 双因子。
   * 只用 machine-id 不够：同一 golden image 克隆出来的 VM/容器 machine-id 相同，
   * 会被误判同台 → cp -a 只在 A 本地执行，B 上什么都没有（无报错的数据错投）。
   * boot_id 每次启动重新生成，克隆机也不同。hostname 不当因子（重名太常见）。
   * 拿不到就返回 null —— 安全方向：当中继，不猜。
   */
  private async machineId(sessionId: string): Promise<string | null> {
    const cached = this.machineIds.get(sessionId)
    if (cached !== undefined) return cached || null
    const client = this.getClient(sessionId)
    if (!client) return null
    let id = ''
    try {
      const r = await execCapture(
        client,
        '(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null; cat /proc/sys/kernel/random/boot_id 2>/dev/null) | tr "\\n" " "',
        { timeoutMs: 5000 }
      )
      id = r.stdout.trim()
    } catch {
      id = ''
    }
    this.machineIds.set(sessionId, id)
    return id || null
  }

  /**
   * 入队前最后一次世代检查：任务创建隔着 await（du/stat/mkdir），
   * 「全部取消」可能正好落在窗口里 —— 不查这一下，清扫之后入队的任务照跑。
   */
  private pushIfCurrent(task: InternalTask, gen: number): boolean {
    if (this.expansionGen !== gen) {
      this.tasks.delete(task.id)
      return false
    }
    this.push(task)
    return true
  }

  /**
   * 同台复制：服务端 `cp -a`，零网络流量。进度靠轮询目标侧已落地字节
   * （同台时「目标侧」就是这台机器自己，dst 连接直接能量）。
   */
  private async cpWithin(
    task: InternalTask,
    sessionId: string,
    parent: string,
    names: string[],
    dstDir: string
  ): Promise<void> {
    const client = this.getClient(sessionId)
    if (!client) throw new Error('会话已断开')
    const quoted = names.map((n) => shQuote(posix.join(parent, n))).join(' ')
    // 失败时把 stderr 首行带上：「退出码 1」分不清是权限不足还是磁盘满
    let stderr = ''
    const handle = execStream(client, `cp -a -- ${quoted} ${shQuote(`${dstDir}/`)}`, {
      timeoutMs: 6 * 3600_000,
      onData: () => undefined,
      onStderr: (text) => {
        if (stderr.length < 4096) stderr += text
      }
    })
    task._cancel = () => handle.cancel()
    this.pollDstSize(task, dstDir, names, handle.done)
    const r = await handle.done
    if (r.canceled || task._cancelRequested) throw new Error(CANCELED)
    if (r.code !== 0) {
      const detail = stderr.split('\n').map((l) => l.trim()).filter(Boolean)[0]
      throw new Error(detail ? `同台复制失败：${detail}` : `同台复制失败（cp 退出码 ${r.code}）`)
    }
  }

  /**
   * 同一台 B 的 P2P 串行锁：authorized_keys 的「读-改-写」（清扫陈旧标记、
   * 追加新公钥、传完删除）不是原子操作，并发任务交错会互相复活/误删标记行。
   * 串行化后，prepare 清扫陈旧标记也安全 —— 此刻没有别的任务处于
   * 「已 append 未连接」的窗口（正在传的 ssh 会话已建立，删行无影响）。
   */
  private p2pLocks = new Map<string, Promise<unknown>>()

  private p2pSerialized<T>(dstSessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.p2pLocks.get(dstSessionId) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(fn)
    this.p2pLocks.set(dstSessionId, run)
    return run
  }

  /**
   * P2P 预备：一次性 ed25519 密钥对，公钥临时进 B 的 authorized_keys（带标记行），
   * 私钥临时放 A 的 /tmp（600）；预飞 `ssh true` 确认 A 能直连 B。
   * 任何一步失败都清理现场并返回 null（调用方落回中继），不报错。
   */
  private async prepareP2p(
    srcSessionId: string,
    dstSessionId: string,
    target: { host: string; port: number; username: string }
  ): Promise<P2PSession | null> {
    const srcClient = this.getClient(srcSessionId)
    const dstClient = this.getClient(dstSessionId)
    if (!srcClient || !dstClient) return null
    // host/username 来自保存的会话配置：过白名单再拼进命令行（防配置被污染时注入）
    if (!/^[a-zA-Z0-9._:-]{1,253}$/.test(target.host)) return null
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(target.username)) return null
    if (!(target.port > 0 && target.port < 65536)) return null

    const uuid = randomUUID().slice(0, 8)
    const keyPath = `/tmp/.dox-p2p-${uuid}`
    const marker = `dox-p2p-${uuid}`
    try {
      // A 上要有 ssh 客户端与 tar
      await execCapture(srcClient, 'command -v ssh && command -v tar', { timeoutMs: 5000 })
      const kp = ssh2.utils.generateKeyPairSync('ed25519', {})
      // B：先清陈旧标记行（上次崩溃/掉线的残留）再追加本次公钥；目录权限一并备好
      const pubLine = `${kp.public.trim()} ${marker}`
      await this.p2pSerialized(dstSessionId, () =>
        execCapture(
          dstClient,
          `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
            `f=~/.ssh/authorized_keys && t=$(mktemp) && (grep -v 'dox-p2p-' "$f" > "$t" || true) && cat "$t" > "$f" && rm -f "$t" && ` +
            `printf '%s\n' ${shQuote(pubLine)} >> "$f"`,
          { timeoutMs: 10_000 }
        )
      )
      // A：私钥落 /tmp。umask 077 先压权限再建文件 —— 先建后 chmod 会给
      // 多用户机器留一个「私钥 644」的毫秒级窗口
      const b64 = Buffer.from(kp.private, 'utf8').toString('base64')
      await execCapture(srcClient, `(umask 077; echo ${shQuote(b64)} | base64 -d > ${keyPath})`, {
        timeoutMs: 10_000
      })
      const sshBase =
        `ssh -i ${keyPath} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 ` +
        `-p ${target.port} ${target.username}@${target.host}`
      // 预飞：连不上 / 密钥被拒立刻失败（BatchMode 不会卡在密码提示上）
      await execCapture(srcClient, `${sshBase} true`, { timeoutMs: 15_000 })
      return { keyPath, marker, sshBase }
    } catch {
      await this.cleanupP2p(srcSessionId, dstSessionId, { keyPath, marker })
      return null
    }
  }

  /**
   * P2P 直传：A 上 `tar -cf - | ssh B 'tar -xf -'`，字节不过本机。
   * 进度靠轮询 B 侧已落地字节（本机与 B 的连接还在，能量）。
   */
  private async p2pCopy(
    task: InternalTask,
    srcSessionId: string,
    p2p: P2PSession,
    parent: string,
    names: string[],
    dstDir: string
  ): Promise<void> {
    const srcClient = this.getClient(srcSessionId)
    if (!srcClient) throw new Error('源会话已断开')
    // 两层引号：shQuote(dstDir) 给 B 的 shell，外层 shQuote 给 A 的 shell（ssh 拿到的是单参数）
    const remoteCmd = `tar -xf - -C ${shQuote(dstDir)}`
    const quoted = names.map((n) => shQuote(n)).join(' ')
    const cmd = `tar -cf - -C ${shQuote(parent)} -- ${quoted} | ${p2p.sshBase} ${shQuote(remoteCmd)}`
    // 失败时把 stderr 首行带上：认证失败/网络不通/磁盘满不能都压成「退出码 1」
    let stderr = ''
    const handle = execStream(srcClient, cmd, {
      timeoutMs: 6 * 3600_000,
      onData: () => undefined,
      onStderr: (text) => {
        if (stderr.length < 4096) stderr += text
      }
    })
    task._cancel = () => handle.cancel()
    this.pollDstSize(task, dstDir, names, handle.done)
    const r = await handle.done
    if (r.canceled || task._cancelRequested) throw new Error(CANCELED)
    if (r.code !== 0) {
      const detail = stderr.split('\n').map((l) => l.trim()).filter(Boolean)[0]
      throw new Error(detail ? `直传失败：${detail}` : `直传失败（A 侧管道退出码 ${r.code}）`)
    }
  }

  /** P2P 收尾：删 A 的私钥、按标记行清 B 的 authorized_keys（尽力而为，不抛错；B 侧操作串行化防并发交错） */
  private async cleanupP2p(
    srcSessionId: string,
    dstSessionId: string,
    p2p: { keyPath: string; marker: string }
  ): Promise<void> {
    const srcClient = this.getClient(srcSessionId)
    if (srcClient) {
      await execCapture(srcClient, `rm -f ${p2p.keyPath}`, { timeoutMs: 5000 }).catch(() => undefined)
    }
    await this.p2pSerialized(dstSessionId, async () => {
      const dstClient = this.getClient(dstSessionId)
      if (!dstClient) return
      // grep -v 后 cat 回写而不是 sed -i：保持原文件的 inode/权限/属主（busybox 的 sed -i 行为不一）
      await execCapture(
        dstClient,
        `f=~/.ssh/authorized_keys; t=$(mktemp) && (grep -v ${shQuote(p2p.marker)} "$f" > "$t" || true) && cat "$t" > "$f" && rm -f "$t"`,
        { timeoutMs: 10_000 }
      ).catch(() => undefined)
    })
  }

  /**
   * 进度轮询：周期性 du 目标侧已落地的顶层条目，合计 ≈ 已传字节。
   * 覆盖写场景下旧内容会被算进去（进度偏快），可接受的近似；
   * du 失败/会话断开都静默跳过 —— 它只是进度条，不是正确性。
   *
   * 节奏 3s + 启动随机相位：8 路并发任务同相轮询会在 dst 连接上瞬时
   * 挤出 8 条 exec 通道（sshd MaxSessions 默认 10，会把 tar/sftp 通道挤失败）；
   * du -sk 两族通吃（busybox 没有 -b），块口径对「近似进度」无影响。
   */
  private pollDstSize(task: InternalTask, dstDir: string, names: string[], done: Promise<unknown>): void {
    if (task.size <= 0) return
    const client = this.getClient(task.sessionId)
    if (!client) return
    const quoted = names.map((n) => shQuote(posix.join(dstDir, n))).join(' ')
    const cmd = `du -sk -- ${quoted} 2>/dev/null | awk '{s+=$1} END {print s*1024}'`
    let finished = false
    // done 可能 reject（通道断/超时）：.finally 会把 rejection 原样传下去变成
    // unhandled rejection —— 用 then 双分支吃掉，这里只要「结束了」这个事实
    void done.then(
      () => {
        finished = true
      },
      () => {
        finished = true
      }
    )
    void (async () => {
      // 启动随机相位，把并发任务的轮询错开
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3000)))
      while (!finished) {
        await new Promise((r) => setTimeout(r, 3000))
        if (finished) break
        try {
          const r = await execCapture(client, cmd, { timeoutMs: 30_000 })
          const n = parseInt(r.stdout.trim(), 10)
          if (Number.isFinite(n) && n > task.transferred) {
            task.transferred = Math.min(task.size, n)
            this.emitThrottled()
          }
        } catch {
          /* 轮询失败不碍事 */
        }
      }
    })()
  }

  /**
   * tar 整流互传：A 的 tar stdout → B 的 tar stdin，主进程逐块中继。   * 背压 = writeChannel 等 drain；取消 = 双通道都关，B 上已解开的文件保留
   * （与 tar 上传/下载「已完成保留」同口径）。
   */
  private async tarRelay(
    task: InternalTask,
    srcSessionId: string,
    srcParent: string,
    names: string[],
    dstDir: string
  ): Promise<void> {
    const srcClient = this.getClient(srcSessionId)
    const dstClient = this.getClient(task.sessionId) // 任务 sessionId 就是目的端
    if (!srcClient || !dstClient) throw new Error('会话已断开')
    const quoted = names.map((n) => shQuote(n)).join(' ')
    const srcCmd = `tar -cf - -C ${shQuote(srcParent)} -- ${quoted}`
    const dstCmd = `tar -xf - -C ${shQuote(dstDir)}`

    // 两端各收一份退出状态；stderr 各攒 4KB 报错用
    const watch = (ch: ClientChannel, label: string): Promise<void> =>
      new Promise((resolve, reject) => {
        let sawExit = false
        let exitCode: number | null = null
        const errChunks: Buffer[] = []
        let errLen = 0
        ch.stderr?.on('data', (c: Buffer) => {
          if (errLen < 4096) {
            errChunks.push(c)
            errLen += c.length
          }
        })
        ch.on('exit', (code: number | null) => {
          sawExit = true
          exitCode = code
        })
        ch.on('error', (err: Error) => reject(err))
        ch.on('close', () => {
          if (task._cancelRequested) {
            reject(new Error(CANCELED))
            return
          }
          if (!sawExit) {
            reject(new Error(`${label}侧连接中断，传输未完成`))
            return
          }
          if (exitCode !== 0) {
            const detail = firstLine(Buffer.concat(errChunks).toString('utf8'))
            reject(new Error(detail || `${label}侧 tar 退出码 ${exitCode}`))
            return
          }
          resolve()
        })
      })

    /*
     * 监听必须在 exec 回调里同步挂上：小文件的 tar 秒退，exit-status 可能
     * 赶在 open 返回之后才到 —— 没人听就被丢掉，接着就是「连接中断」的冤案。
     */
    const open = (
      client: Client,
      cmd: string,
      label: string
    ): Promise<{ ch: ClientChannel; done: Promise<void> }> =>
      new Promise((resolve, reject) => {
        try {
          client.exec(cmd, { pty: false }, (err, ch) => {
            if (err) {
              reject(err)
              return
            }
            resolve({ ch, done: watch(ch, label) })
          })
        } catch (err) {
          reject(err as Error)
        }
      })

    const src = await open(srcClient, srcCmd, '源')
    const srcCh = src.ch
    const srcDone = src.done
    let dst: { ch: ClientChannel; done: Promise<void> }
    try {
      dst = await open(dstClient, dstCmd, '目标')
    } catch (err) {
      srcCh.close()
      srcDone.catch(() => undefined)
      throw err
    }
    const dstCh = dst.ch
    const dstDone = dst.done
    /*
     * 目的端通道的读侧必须放行（resume）：ssh2 的 Duplex 要等读侧流完才发
     * 'close'，没人读就永远等 —— 远端 tar 明明已退出，任务却卡在 active。
     * tar -xf 本来也不往 stdout 写东西，纯粹是放行读侧（同 tarUpload 的坑）。
     */
    dstCh.resume()
    /*
     * 取消要能打断「数据没在流动」的等待：卡在 writeChannel 的 drain 或
     * Promise.all 的收尾时，循环里的逐块检查帮不上忙。close 双通道后，
     * writeChannel 的 onClose / watch 会以 CANCELED 落定（suppressor 已兜住）。
     */
    task._cancel = () => {
      srcCh.close()
      dstCh.close()
    }
    // 通道建立前就点过取消：立刻关，别让远端把活跑起来
    if (task._cancelRequested) {
      srcCh.close()
      dstCh.close()
    }

    try {
      for await (const chunk of srcCh) {
        if (task._cancelRequested) throw new Error(CANCELED)
        task.transferred += (chunk as Buffer).length
        this.emitThrottled()
        await this.writeChannel(dstCh, chunk as Buffer)
      }
      if (task._cancelRequested) throw new Error(CANCELED)
      // 源端 EOF：给目的端收尾信号，等两端 tar 各自落定
      dstCh.end()
      await Promise.all([srcDone, dstDone])
    } catch (err) {
      srcCh.close()
      dstCh.close()
      // 关通道会让两个 watch 异步 reject：先挂 suppressor 再抛，
      // 不然取消路径的「__transfer_canceled__」变成未处理拒绝把进程打崩
      srcDone.catch(() => undefined)
      dstDone.catch(() => undefined)
      // 取消优先：tar 非正常退出是被我们掐的，不算失败
      if (task._cancelRequested) throw new Error(CANCELED)
      throw err
    }
  }

  /**
   * 慢路单文件中继：源 SFTP 带 offset 读一块 → 目的 SFTP 同 offset 写一块。
   * 8 路在途（≈2MB），worker 各自「读+写」串成一环，窗口天然背压 ——
   * 两端速度不一致时在途块数就是缓冲上限，不会无限攒内存。
   */
  private async fileRelay(task: InternalTask, srcSessionId: string): Promise<void> {
    if (task._cancelRequested) throw new Error(CANCELED)
    const CHUNK = 256 * 1024
    const CONCURRENCY = 8
    const srcSftp = await this.getSftp(srcSessionId)
    const dstSftp = await this.getSftp(task.sessionId)

    const openH = (sftp: SFTPWrapper, p: string, flags: 'r' | 'w'): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        sftp.open(p, flags, (err, h) => (err ? reject(err) : resolve(h)))
      })
    const closeH = (sftp: SFTPWrapper, h: Buffer): Promise<void> =>
      new Promise((resolve) => sftp.close(h, () => resolve()))

    const srcH = await openH(srcSftp, task.localPath, 'r')
    let dstH: Buffer
    let total: number
    try {
      const stats = await new Promise<{ size: number }>((resolve, reject) => {
        srcSftp.fstat(srcH, (err, st) => (err ? reject(err) : resolve(st)))
      })
      total = stats.size
      dstH = await openH(dstSftp, task.remotePath, 'w')
    } catch (err) {
      await closeH(srcSftp, srcH)
      throw err
    }

    let readPos = 0
    let failure: Error | null = null
    task._cancel = () => {
      if (!failure) failure = new Error(CANCELED)
    }
    if (task._cancelRequested) failure = new Error(CANCELED)

    const worker = async (): Promise<void> => {
      const buf = Buffer.allocUnsafe(CHUNK)
      for (;;) {
        if (failure) return
        const pos = readPos
        if (pos >= total) return
        const len = Math.min(CHUNK, total - pos)
        readPos += len

        const bytesRead = await new Promise<number>((resolve) => {
          srcSftp.read(srcH, buf, 0, len, pos, (err, n) => {
            if (err) {
              if (!failure) failure = err
              resolve(0)
            } else {
              resolve(n)
            }
          })
        })
        if (bytesRead === 0 || failure) return
        await new Promise<void>((resolve) => {
          dstSftp.write(dstH, buf, 0, bytesRead, pos, (err) => {
            if (err) {
              if (!failure) failure = err
            } else {
              task.transferred += bytesRead
              this.emitThrottled()
            }
            resolve()
          })
        })
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    } finally {
      await closeH(dstSftp, dstH!)
      await closeH(srcSftp, srcH)
    }

    const err = failure as Error | null
    if (err) {
      // 取消：删掉目的端半截（句柄已关，不赛跑）；失败：留着给断点续传
      if (err.message === CANCELED) {
        await unlinkP(dstSftp, task.remotePath).catch(() => undefined)
      }
      throw err
    }
  }


  // ---- 容器传输：SFTP（本机 ↔ 宿主机 /tmp 中转）+ docker cp（中转 ↔ 容器）两段接力 ----

  /**
   * 上传到容器。文件/目录都展开成文件级任务（目录经 walkLocal），
   * 每个任务自带独立中转目录：SFTP 传到宿主机 /tmp → docker cp 进容器 →
   * 删中转。逐任务独立中转免去批次协调与并发清理的竞态；
   * 逐文件 cp 比整包慢（大批小文件明显），换来逐文件进度与取消。
   */
  async enqueueUploadContainer(
    sessionId: string,
    containerName: string,
    localPath: string,
    remoteDir: string,
    io: ContainerIO
  ): Promise<TransferTask[]> {
    const gen = this.expansionGen
    const stat = await fs.promises.stat(localPath)

    /*
     * 容器目录创建去重：目录里的每个文件任务都会 ensure 一次父目录，
     * 不缓存就是「文件数 × agent RTT」。缓存 promise 而不是结果 ——
     * 8 路并发任务可能同时 ensure 同一目录，promise 让它们共享那一次调用。
     */
    const ctrDirCalls = new Map<string, Promise<void>>()
    const ensureCtrDir = (dir: string): Promise<void> => {
      let p = ctrDirCalls.get(dir)
      if (!p) {
        p = Promise.resolve(io.mkdirContainer(dir))
        ctrDirCalls.set(dir, p)
      }
      return p
    }

    const makeTask = (lPath: string, rel: string, size: number, displayName?: string): InternalTask => {
      const ctrPath = posix.join(remoteDir, rel)
      // agent ≥0.4.0：分块直传，无中转、真进度、distroless 可传
      const stream = io.stream
      if (stream) {
        const task = this.createTask(sessionId, 'upload', lPath, ctrPath, size, displayName, containerName)
        task._stream = async (t) => {
          await ensureCtrDir(posix.dirname(ctrPath))
          await stream.upload(
            lPath,
            ctrPath,
            (n) => {
              t.transferred = n
              this.emitThrottled()
            },
            () => !!t._cancelRequested
          )
        }
        return task
      }
      // 老 agent 回退：SFTP → 宿主机中转 → docker cp
      const stage = `/tmp/.dox-stage-${randomUUID().slice(0, 8)}`
      const stagePath = posix.join(stage, posix.basename(rel))
      const task = this.createTask(sessionId, 'upload', lPath, stagePath, size, displayName, containerName)
      task._prepare = async () => {
        const sftp = await this.getSftp(sessionId)
        await mkdirRemoteRecursive(sftp, stage)
        await ensureCtrDir(posix.dirname(ctrPath))
      }
      task._finalize = async () => {
        await io.cp(stagePath, `${containerName}:${ctrPath}`)
        await io.rmHostStage(stage)
      }
      task._cleanupStage = () => void io.rmHostStage(stage)
      return task
    }

    if (stat.isFile()) {
      const task = makeTask(localPath, basename(localPath), stat.size)
      this.push(task)
      return [this.snapshot(task)]
    }
    if (stat.isDirectory()) {
      const rootName = basename(localPath)
      const files = await walkLocal(localPath, () => this.expansionGen !== gen)
      const created: TransferTask[] = []
      for (const f of files) {
        // 全部取消后已遍历出的文件不再入队
        if (this.expansionGen !== gen) break
        const rel = `${rootName}/${toPosixRel(f.rel)}`
        const task = makeTask(f.path, rel, f.size, rel)
        this.push(task)
        created.push(this.snapshot(task))
      }
      return created
    }
    return []
  }

  /** 从容器下载文件：agent ≥0.4.0 分块直传；老 agent 回退 docker cp 中转 */
  async enqueueDownloadContainer(
    sessionId: string,
    containerName: string,
    remotePath: string,
    localPath: string,
    io: ContainerIO
  ): Promise<TransferTask> {
    const st = await io.statContainer(remotePath)
    const stream = io.stream
    if (stream) {
      const task = this.createTask(sessionId, 'download', localPath, remotePath, st.size, undefined, containerName)
      task._stream = (t) =>
        stream.download(
          remotePath,
          localPath,
          (n) => {
            t.transferred = n
            this.emitThrottled()
          },
          () => !!t._cancelRequested
        )
      this.push(task)
      return this.snapshot(task)
    }
    const stage = `/tmp/.dox-stage-${randomUUID().slice(0, 8)}`
    const stagePath = posix.join(stage, posix.basename(remotePath))
    const task = this.createTask(sessionId, 'download', localPath, stagePath, st.size, undefined, containerName)
    task._prepare = async () => {
      const sftp = await this.getSftp(sessionId)
      await mkdirRemoteRecursive(sftp, stage)
      await io.cp(`${containerName}:${remotePath}`, stagePath)
    }
    task._finalize = () => io.rmHostStage(stage)
    task._cleanupStage = () => void io.rmHostStage(stage)
    this.push(task)
    return this.snapshot(task)
  }

  /** 从容器下载文件夹：容器内经 agent fs_list 递归展开，逐文件两段接力 */
  async enqueueDownloadDirContainer(
    sessionId: string,
    containerName: string,
    remotePath: string,
    localDir: string,
    io: ContainerIO
  ): Promise<TransferTask[]> {
    const gen = this.expansionGen
    const rootName = sanitizeWinName(posix.basename(remotePath))
    const rootLocal = join(localDir, rootName)
    await fs.promises.mkdir(rootLocal, { recursive: true })

    const created: TransferTask[] = []
    const walk = async (rDir: string, lDir: string, relDir: string): Promise<void> => {
      const items = await io.listContainer(rDir)
      const subdirs: Array<{ rChild: string; lChild: string; rel: string }> = []
      for (const item of items) {
        if (this.expansionGen !== gen) return
        if (item.isSymlink) continue // 与宿主机的下载目录一致：符号链接不跟随
        const rChild = posix.join(rDir, item.name)
        const rel = relDir ? `${relDir}/${item.name}` : item.name
        if (item.isDir) {
          const lChild = join(lDir, sanitizeWinName(item.name))
          await fs.promises.mkdir(lChild, { recursive: true })
          subdirs.push({ rChild, lChild, rel })
        } else {
          const lChild = join(lDir, sanitizeWinName(item.name))
          const stream = io.stream
          if (stream) {
            // 直传：不经过宿主中转，落盘就是最终位置
            const task = this.createTask(
              sessionId,
              'download',
              lChild,
              rChild,
              item.size,
              `${rootName}/${rel}`,
              containerName
            )
            task._stream = (t) =>
              stream.download(
                rChild,
                lChild,
                (n) => {
                  t.transferred = n
                  this.emitThrottled()
                },
                () => !!t._cancelRequested
              )
            this.push(task)
            created.push(this.snapshot(task))
            continue
          }
          const stage = `/tmp/.dox-stage-${randomUUID().slice(0, 8)}`
          const stagePath = posix.join(stage, item.name)
          const task = this.createTask(
            sessionId,
            'download',
            join(lDir, sanitizeWinName(item.name)),
            stagePath,
            item.size,
            `${rootName}/${rel}`,
            containerName
          )
          task._prepare = async () => {
            const sftp = await this.getSftp(sessionId)
            await mkdirRemoteRecursive(sftp, stage)
            await io.cp(`${containerName}:${rChild}`, stagePath)
          }
          task._finalize = () => io.rmHostStage(stage)
          task._cleanupStage = () => void io.rmHostStage(stage)
          this.push(task)
          created.push(this.snapshot(task))
        }
      }
      // 兄弟目录 8 路并发展开：listContainer 每目录一次 agent RTT，
      // 串行 DFS 在宽目录树下是纯「目录数 × RTT」的等待
      for (let i = 0; i < subdirs.length && this.expansionGen === gen; i += 8) {
        await Promise.all(subdirs.slice(i, i + 8).map((d) => walk(d.rChild, d.lChild, d.rel)))
      }
    }
    await walk(remotePath, rootLocal, '')

    if (created.length === 0) {
      const task = this.createTask(sessionId, 'download', rootLocal, remotePath, 0, `${rootName}/`)
      this.settle(task, 'done')
      this.emit()
      return [this.snapshot(task)]
    }
    return created
  }

  /**
   * 全部取消：停掉所有排队/进行中的任务，并中断还在跑的目录展开。
   *
   * 传文件夹时队列里会有成百上千条，一条条点取消既点不完也点不过来；
   * 而且只要遍历没停，取消掉的总会被新冒出来的补上。
   */
  cancelAll(): void {
    this.expansionGen++
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
    displayName?: string,
    containerName?: string
  ): InternalTask {
    const task: InternalTask = {
      id: randomUUID(),
      sessionId,
      containerName,
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
    return publicTask(task)
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
      if (task._stream) {
        // 容器直传：agent 分块流式，全程不经 SFTP/中转（取消由 _stream 内
        // 逐块检查 _cancelRequested 抛 CANCELED 实现）
        await task._stream(task)
      } else {
        const sftp = await this.getSftp(task.sessionId)
        if (task._prepare) await task._prepare()
        await this.pipe(task, sftp)
        if (task._finalize) await task._finalize()
      }
      task.transferred = task.size
      this.settle(task, 'done')
    } catch (err) {
      const e = err as Error
      task._cleanupStage?.()
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
    if (task.direction === 'upload') return this.uploadPipelined(task, sftp)
    return this.downloadPipelined(task, sftp)
  }

  /**
   * 下载专用：fastGet 式并发管道读。
   *
   * 之前走 ReadStream（1MB hwm）：ssh2 的 SFTP ReadStream 同一时刻只有一个
   * 在途 READ，OpenSSH 服务端又把单次响应砍到 256KB —— 等于 256KB/RTT 的
   * 纯串行。Wi-Fi ~10ms RTT 上理论 25MB/s，实测只有 ~10MB/s（500MB 要 49s），
   * 是同链路 scp（57MB/s）的 1/6。
   *
   * 这里改成与 uploadPipelined 同构的 48 路 worker（fastGet 同款形态）：
   * 每路「带偏移 READ 一块 → 带偏移写本地一块」，在途 READ 稳定 48 个，
   * 实测 63MB/s，反超 scp。内存上限 = 48 × 256KB ≈ 12MB / 条活动下载。
   *
   * 收尾语义与旧 pipeStreams 对齐：取消 → 等在途请求落定、关句柄、再删本地
   * 半截文件；出错（非取消）→ 半截留着给断点续传。
   */
  private async downloadPipelined(task: InternalTask, sftp: SFTPWrapper): Promise<void> {
    if (task._cancelRequested) throw new Error(CANCELED)

    const CHUNK = 256 * 1024
    const CONCURRENCY = 48
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(task.remotePath, 'r', (err, h) => (err ? reject(err) : resolve(h)))
    })
    let total: number
    let fh: FileHandle
    try {
      const stats = await new Promise<{ size: number }>((resolve, reject) => {
        sftp.fstat(handle, (err, st) => (err ? reject(err) : resolve(st)))
      })
      total = stats.size
      fh = await fs.promises.open(task.localPath, 'w')
    } catch (err) {
      // fstat/本地文件打开失败时也要释放远端句柄，否则长时间传输会耗尽
      // sshd 的 SFTP handle 配额。
      await new Promise<void>((resolve) => sftp.close(handle, () => resolve()))
      throw err
    }

    let readPos = 0
    let failure: Error | null = null
    task._cancel = () => {
      if (!failure) failure = new Error(CANCELED)
    }
    // 取消可能发生在 open/fstat 期间，此时 _cancel 尚未安装；补读标记。
    if (task._cancelRequested) failure = new Error(CANCELED)

    const worker = async (): Promise<void> => {
      const buf = Buffer.allocUnsafe(CHUNK)
      for (;;) {
        if (failure) return
        // 分配块位置：同步代码段，worker 之间不会交错
        const pos = readPos
        if (pos >= total) return
        const len = Math.min(CHUNK, total - pos)
        readPos += len

        const bytesRead = await new Promise<number>((resolve) => {
          sftp.read(handle, buf, 0, len, pos, (err, n) => {
            if (err) {
              if (!failure) failure = err
              resolve(0)
            } else {
              resolve(n)
            }
          })
        })
        if (bytesRead === 0) return // EOF 或出错（出错时 failure 已置）
        if (failure) return
        try {
          await fh.write(buf, 0, bytesRead, pos)
        } catch (err) {
          if (!failure) failure = err as Error
          return
        }
        task.transferred += bytesRead
        this.emitThrottled()
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    } finally {
      // 等在途请求全部落定后才关句柄；之后删半截文件才不和句柄释放赛跑
      await fh!.close().catch(() => undefined)
      await new Promise<void>((resolve) => sftp.close(handle, () => resolve()))
    }

    // failure 的写入全在闭包里，TS 流分析到这已把它窄化成 null —— 断言绕开
    const err = failure as Error | null
    if (err) {
      if (err.message === CANCELED) {
        await fs.promises.unlink(task.localPath).catch(() => undefined)
      }
      throw err
    }
  }

  /**
   * 上传专用：fastPut 式并发管道写。
   *
   * 之前走 WriteStream（256KB 读 → 4MB hwm 写）：ssh2 的 WriteStream 靠 _writev
   * 把排队 chunk 打出去，但在途 WRITE 数跟着 hwm 走，4MB 也就十几个 ——
   * 有点延迟的链路（Wi-Fi ~10ms RTT）上窗口填不满，实测内网只有 ~39MB/s。
   *
   * 这里改成固定 256KB 块 × 48 路「读一块写一块」的 worker 循环（fastPut 同款
   * 形态）：写请求自带偏移量，无需保序，在途 WRITE 稳定在 48 个，窗口始终
   * 是满的，实测同一链路 48MB/s（打满 Wi-Fi），与 scp 持平。
   * 内存上限 = 48 × 256KB ≈ 12MB / 条活动上传。
   *
   * 收尾语义与 pipeStreams 对齐：取消 → 等在途写落定、关句柄、再删远端半截
   * 文件（不和句柄释放赛跑）；出错（非取消）→ 半截文件**留着**给断点续传。
   */
  private async uploadPipelined(task: InternalTask, sftp: SFTPWrapper): Promise<void> {
    // getSftp / 排队期间被取消：那时 _cancel 还没挂上，这里补一次
    if (task._cancelRequested) throw new Error(CANCELED)

    const CHUNK = 256 * 1024
    const CONCURRENCY = 48
    const { size: total } = await fs.promises.stat(task.localPath)
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(task.remotePath, 'w', (err, h) => (err ? reject(err) : resolve(h)))
    })
    let fh: FileHandle
    try {
      fh = await fs.promises.open(task.localPath, 'r')
    } catch (err) {
      await new Promise<void>((resolve) => sftp.close(handle, () => resolve()))
      throw err
    }

    let readPos = 0
    /** 第一个错误赢；取消也是经由它传播（_cancel 只置标记，由 worker 循环收尾） */
    let failure: Error | null = null
    task._cancel = () => {
      if (!failure) failure = new Error(CANCELED)
    }
    // 同上：句柄建立期间的取消不能被漏掉。
    if (task._cancelRequested) failure = new Error(CANCELED)

    const worker = async (): Promise<void> => {
      const buf = Buffer.allocUnsafe(CHUNK)
      for (;;) {
        if (failure) return
        // 分配块位置：同步代码段，worker 之间不会交错
        const pos = readPos
        if (pos >= total) return
        const len = Math.min(CHUNK, total - pos)
        readPos += len

        let bytesRead: number
        try {
          ;({ bytesRead } = await fh.read(buf, 0, len, pos))
        } catch (err) {
          if (!failure) failure = err as Error
          return
        }
        if (bytesRead === 0) return // 传输期间本地文件被截短
        if (failure) return
        await new Promise<void>((resolve) => {
          sftp.write(handle, buf, 0, bytesRead, pos, (err) => {
            if (err) {
              if (!failure) failure = err
            } else {
              task.transferred += bytesRead
              this.emitThrottled()
            }
            resolve()
          })
        })
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    } finally {
      // 等在途写全部落定后才关句柄；之后删半截文件才不和句柄释放赛跑
      await fh!.close().catch(() => undefined)
      await new Promise<void>((resolve) => sftp.close(handle, () => resolve()))
    }

    // failure 的写入全在闭包里，TS 流分析到这已把它窄化成 null —— 断言绕开
    const err = failure as Error | null
    if (err) {
      if (err.message === CANCELED) {
        await unlinkP(sftp, task.remotePath).catch(() => undefined)
      }
      throw err
    }
  }

  /**
   * 流式搬运主体：src → dst，逐 chunk 报进度，取消/出错在句柄关闭后收尾。
   * SFTP 上传下载与本机复制共用（本机复制两端都是本地流，见 enqueueLocalCopy）。
   */
  private pipeStreams(
    task: InternalTask,
    src: Readable,
    dst: Writable,
    cancelCleanup: () => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // getSftp / 排队期间被取消：那时 _cancel 还没挂上，这里补一次
      if (task._cancelRequested) {
        reject(new Error(CANCELED))
        return
      }

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
        abort(new Error(CANCELED), cancelCleanup)
      }

      src.pipe(dst)
    })
  }

  /**
   * tar 上传用的本地遍历：目录条目也要（保空目录、目录 mtime），
   * 顺序即 tar 内顺序（父目录在其内容之前）。
   * 返回 false = 被「全部取消」中断。
   */
  private async walkTarLocal(
    localRoot: string,
    rootName: string,
    out: LocalTarEntry[],
    isCanceled: () => boolean
  ): Promise<boolean> {
    const pushDir = async (absPath: string, tarName: string): Promise<void> => {
      const st = await fs.promises.stat(absPath)
      out.push({
        path: absPath,
        name: `${tarName}/`,
        size: 0,
        mode: st.mode & 0o777,
        mtime: Math.floor(st.mtimeMs / 1000),
        isDir: true
      })
    }
    const walk = async (dir: string, relDir: string): Promise<boolean> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (isCanceled()) return false
        const full = join(dir, entry.name)
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        const tarName = `${rootName}/${toPosixRel(rel)}`
        if (entry.isDirectory()) {
          await pushDir(full, tarName)
          if (!(await walk(full, rel))) return false
        } else if (entry.isFile()) {
          const st = await fs.promises.stat(full)
          out.push({
            path: full,
            name: tarName,
            size: st.size,
            mode: st.mode & 0o777,
            mtime: Math.floor(st.mtimeMs / 1000),
            isDir: false
          })
        }
        // 符号链接等跳过（与逐文件路径同一口径：不跟链）
      }
      return true
    }
    await pushDir(localRoot, rootName)
    return walk(localRoot, '')
  }

  /** 往通道写一块，尊重背压；等 drain 期间通道死了要立刻醒而不是挂住 */
  private writeChannel(channel: ClientChannel, buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      let flushed = false
      try {
        flushed = channel.write(buf)
      } catch (err) {
        reject(err as Error)
        return
      }
      if (flushed) {
        resolve()
        return
      }
      const cleanup = (): void => {
        channel.off('drain', onDrain)
        channel.off('close', onClose)
        channel.off('error', onError)
      }
      const onDrain = (): void => {
        cleanup()
        resolve()
      }
      const onClose = (): void => {
        cleanup()
        reject(new Error('通道已关闭'))
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      channel.once('drain', onDrain)
      channel.once('close', onClose)
      channel.once('error', onError)
    })
  }

  /**
   * tar 整流上传：本地生成 tar 字节流 → exec `tar -xf - -C <remoteDir>` 的 stdin。
   * 远端边收边解（没有「传完再解压」阶段）；取消 = 关通道，远端 tar 拿 EOF 自退，
   * 已解开的文件保留（与逐文件路径「已完成保留」同口径），正在写的那个可能是半截。
   */
  private async tarUpload(task: InternalTask, entries: LocalTarEntry[], remoteDir: string): Promise<void> {
    const client = this.getClient(task.sessionId)
    if (!client) throw new Error('会话已断开')
    const cmd = `tar -xf - -C ${shQuote(remoteDir)}`

    return new Promise<void>((resolve, reject) => {
      client.exec(cmd, { pty: false }, (execErr, channel) => {
        if (execErr) {
          reject(execErr)
          return
        }
        let exitCode: number | null = null
        let sawExit = false
        const errChunks: Buffer[] = []
        let errLen = 0
        channel.stderr?.on('data', (c: Buffer) => {
          if (errLen < 4096) {
            errChunks.push(c)
            errLen += c.length
          }
        })
        channel.on('exit', (code: number | null) => {
          sawExit = true
          exitCode = code
        })
        channel.on('error', (err: Error) => reject(err))
        /*
         * 读侧必须消费（resume）：ssh2 的 Duplex 要等读侧流完才发 'close'，
         * 没人读就永远等 —— 远端 tar 明明已退出（exit 0 都到了），任务却
         * 卡在 active 不落定。stdout 本来没内容（tar 静默），纯粹是放行读侧。
         */
        channel.resume()
        channel.on('close', () => {
          // 取消的优先级最高：取消导致的 EOF 会让 tar 非零退出，别覆盖成「失败」
          if (task._cancelRequested) {
            reject(new Error(CANCELED))
            return
          }
          if (!sawExit) {
            reject(new Error('连接中断，传输未完成'))
            return
          }
          if (exitCode !== 0) {
            const detail = firstLine(Buffer.concat(errChunks).toString('utf8'))
            reject(new Error(detail || `远端 tar 退出码 ${exitCode}`))
            return
          }
          resolve()
        })

        // 写流主体：头块 + 文件内容 + 填充 + 结束块，全程逐块查取消
        void (async () => {
          try {
            for (const entry of entries) {
              if (task._cancelRequested) throw new Error(CANCELED)
              for (const hb of tarHeaderBlocks(entry)) {
                task.transferred += hb.length
                await this.writeChannel(channel, hb)
              }
              if (entry.isDir) continue
              const rs = fs.createReadStream(entry.path)
              try {
                for await (const chunk of rs) {
                  if (task._cancelRequested) throw new Error(CANCELED)
                  task.transferred += (chunk as Buffer).length
                  this.emitThrottled()
                  await this.writeChannel(channel, chunk as Buffer)
                }
              } finally {
                rs.destroy()
              }
              const pad = tarPadSize(entry.size)
              if (pad) {
                task.transferred += pad
                await this.writeChannel(channel, Buffer.alloc(pad))
              }
              this.emitThrottled()
            }
            const trailer = tarTrailer()
            task.transferred += trailer.length
            await this.writeChannel(channel, trailer)
            // EOF 给远端 tar：它解完最后一块自己退出，结果由 close/exit 落定
            channel.end()
          } catch (err) {
            channel.close()
            reject(err as Error)
          }
        })()
      })
    })
  }

  /**
   * tar 整流下载：exec `tar -cf - -C <父目录> <名>` 的 stdout 边收边解边写盘。
   * 背压靠 for-await（await 磁盘写期间通道自动暂停）；取消 = 关通道 +
   * 删掉正在写的半截文件，已解开的文件保留（同逐文件路径口径）。
   */
  private async tarDownload(task: InternalTask, remotePath: string, localDir: string): Promise<void> {
    const client = this.getClient(task.sessionId)
    if (!client) throw new Error('会话已断开')
    // `--` 防止合法但以 '-' 开头的目录名被 tar 当成选项。
    const cmd = `tar -cf - -C ${shQuote(posix.dirname(remotePath))} -- ${shQuote(posix.basename(remotePath))}`

    return new Promise<void>((resolve, reject) => {
      client.exec(cmd, { pty: false }, (execErr, channel) => {
        if (execErr) {
          reject(execErr)
          return
        }
        let exitCode: number | null = null
        let sawExit = false
        const errChunks: Buffer[] = []
        let errLen = 0
        channel.stderr?.on('data', (c: Buffer) => {
          if (errLen < 4096) {
            errChunks.push(c)
            errLen += c.length
          }
        })
        channel.on('exit', (code: number | null) => {
          sawExit = true
          exitCode = code
        })
        channel.on('error', (err: Error) => reject(err))
        // EOF（for-await 结束）可能先于 exit-status 到达，退出码要等 close 再判
        const closed = new Promise<void>((res) => channel.on('close', res))

        const parser = new TarParser()
        let writer: fs.WriteStream | null = null
        let currentFile: string | null = null

        const closeWriter = async (): Promise<void> => {
          if (!writer) return
          const w = writer
          writer = null
          await new Promise<void>((res) => w.end(res))
        }
        const dropHalf = (): void => {
          if (currentFile) void fs.promises.unlink(currentFile).catch(() => undefined)
          currentFile = null
        }
        const emitProgress = (): void => this.emitThrottled()

        const sink: TarSink = {
          async onDir(entry) {
            const p = safeLocalJoin(localDir, entry.name)
            if (p) await fs.promises.mkdir(p, { recursive: true })
          },
          async onFileStart(entry) {
            const p = safeLocalJoin(localDir, entry.name)
            if (!p) {
              // 越界条目：数据照样读完（丢弃），别污染解析状态
              currentFile = null
              return
            }
            await fs.promises.mkdir(dirname(p), { recursive: true })
            currentFile = p
            // 默认 16KB hwm 会把 write syscall 放大 64 倍，慢盘上 drain 反压整个通道
            writer = fs.createWriteStream(p, { highWaterMark: 1024 * 1024 })
            writer.on('error', (err) => {
              channel.close()
              reject(err)
            })
          },
          async onFileData(chunk) {
            // task.size 使用 du 得到的文件字节数；tar 头、填充和结束块
            // 不计入进度，否则进度会超过 100%。
            task.transferred += chunk.length
            emitProgress()
            if (!writer) return
            if (!writer.write(chunk)) {
              await new Promise<void>((res) => writer!.once('drain', res))
            }
          },
          async onFileEnd() {
            await closeWriter()
            currentFile = null
          }
        }

        void (async () => {
          try {
            let canceled = false
            for await (const chunk of channel) {
              if (task._cancelRequested) {
                canceled = true
                channel.close()
                break
              }
              await parser.push(chunk as Buffer, sink)
            }
            await closeWriter()
            /*
             * 取消路径不能等 'close'：for-await 被 break 会销毁读侧，
             * ssh2 的 Channel 在本地销毁后不再发 'close' —— 等了就是
             * 任务卡在 active 永不落定。正常结束（远端 EOF）才能等。
             */
            if (canceled || task._cancelRequested) {
              dropHalf()
              reject(new Error(CANCELED))
              return
            }
            await closed
            if (task._cancelRequested) {
              dropHalf()
              reject(new Error(CANCELED))
              return
            }
            if (!sawExit) {
              reject(new Error('连接中断，传输未完成'))
              return
            }
            if (exitCode !== 0) {
              const detail = firstLine(Buffer.concat(errChunks).toString('utf8'))
              reject(new Error(detail || `远端 tar 退出码 ${exitCode}`))
              return
            }
            resolve()
          } catch (err) {
            await closeWriter()
            dropHalf()
            channel.close()
            reject(err as Error)
          }
        })()
      })
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

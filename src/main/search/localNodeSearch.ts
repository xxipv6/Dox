/*
 * 本机兜底搜索引擎（Windows 无 grep / rg 未装时）：纯 Node 顺序遍历。
 *
 * 顺序而非并发：这是最后兜底档，正确性和代码可测性优先于速度
 * （agent 的 Go 侧才是「对标 rg」的那一档）。显式 .ts 后缀 +
 * 类型独立 import type：verify-search.mjs 阶段 1 直 import。
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { SEARCH_EXCLUDE_DIRS, SEARCH_MAX_PER_FILE, truncatePreview } from './commands.ts'
import type { SearchMatch } from '../../shared/types.ts'

const MAX_FILE_BYTES = 32 * 1024 * 1024 // 与 agent fs_search 同口径
const BINARY_SNIFF_BYTES = 512
/** 时间预算（撞线 truncated 收手；agent 侧缺省 8s，这里同档） */
const NODE_BUDGET_MS = 8000

export interface NodeSearchHooks {
  /** 每文件（有命中时）回吐一批；调用方负责合流成 SearchEvent */
  onBatch: (matches: SearchMatch[]) => void
  /** 协作取消（用户改了关键词/关了面板）；每目录查一次 */
  shouldAbort: () => boolean
}

export interface NodeSearchResult {
  truncated: boolean
  filesSearched: number
}

export async function searchLocalNode(
  root: string,
  matcher: (line: string) => number,
  maxResults: number,
  hooks: NodeSearchHooks
): Promise<NodeSearchResult> {
  const started = Date.now()
  let filesSearched = 0
  let total = 0
  let truncated = false

  // 顺序 BFS：队列里是待扫目录
  const queue: string[] = [root]
  while (queue.length) {
    if (hooks.shouldAbort()) break
    if (Date.now() - started > NODE_BUDGET_MS || total >= maxResults) {
      truncated = true
      break
    }
    const dir = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 权限/消失：跳过
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!(SEARCH_EXCLUDE_DIRS as readonly string[]).includes(e.name)) queue.push(full)
        continue
      }
      // symlink 不跟（与 WalkDir 口径一致：当链接本身处理，不进目标）
      if (!e.isFile()) continue
      try {
        const st = await fs.stat(full)
        if (st.size > MAX_FILE_BYTES) continue
      } catch {
        continue
      }
      const perFile = await searchOne(full, matcher, maxResults - total)
      if (perFile.searched) filesSearched++
      if (perFile.matches.length) {
        total += perFile.matches.length
        hooks.onBatch(perFile.matches)
      }
      if (total >= maxResults) {
        truncated = true
        break
      }
      // 注意：单文件撞 SEARCH_MAX_PER_FILE（hitFileCap）**不**结束目录循环 ——
      // 那只是「这个文件命中太多」，这里 break 会把同目录其余文件与
      // 未入队的子目录整批漏掉，还不报截断（漏得无声无息）
    }
  }
  return { truncated, filesSearched }
}

async function searchOne(
  file: string,
  matcher: (line: string) => number,
  remaining: number
): Promise<{ matches: SearchMatch[]; searched: boolean; hitFileCap: boolean }> {
  const matches: SearchMatch[] = []
  // 先读 512 字节做二进制嗅探，再决定要不要读全量 —— 整读再扔在目录里
  // 大量二进制文件（图片/构建产物）时是纯浪费
  let buf: Buffer
  try {
    const fh = await fs.open(file, 'r')
    try {
      const head = Buffer.alloc(BINARY_SNIFF_BYTES)
      const first = await fh.read(head, 0, BINARY_SNIFF_BYTES, 0)
      // 二进制判定：首 512 字节含 \0 整文件跳过（rg/agent 同口径）
      if (head.subarray(0, first.bytesRead).includes(0)) {
        return { matches, searched: false, hitFileCap: false }
      }
      const { size } = await fh.stat()
      buf = Buffer.alloc(size)
      head.copy(buf, 0, 0, first.bytesRead)
      let off = first.bytesRead
      while (off < size) {
        const r = await fh.read(buf, off, size - off, off)
        if (r.bytesRead === 0) break
        off += r.bytesRead
      }
    } finally {
      await fh.close()
    }
  } catch {
    return { matches, searched: false, hitFileCap: false }
  }
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  let hitFileCap = false
  for (let i = 0; i < lines.length; i++) {
    const col = matcher(lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i])
    if (col < 0) continue
    matches.push({
      path: file,
      line: i + 1,
      col,
      text: truncatePreview(lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i])
    })
    if (matches.length >= SEARCH_MAX_PER_FILE || matches.length >= remaining) {
      hitFileCap = true
      break
    }
  }
  return { matches, searched: true, hitFileCap }
}

/*
 * 搜索命令构造 + 输出解析：纯函数，零依赖。
 *
 * 显式 .ts 后缀 + 类型独立 import type：verify-search.mjs 阶段 1 用
 * Node 24 type stripping 直接 import 本文件（与 remoteExec.ts 同约束）。
 */
import type { SearchMatch, SearchStartParams } from '../../shared/types.ts'

/** 三引擎统一的内置排除清单（与 agent fs_search 的 map 一一对应，改一边必须改另一边） */
export const SEARCH_EXCLUDE_DIRS = ['.git', '.hg', '.svn', 'node_modules'] as const

/** 单文件匹配上限（rg --max-count / grep -m / agent 侧各自落地） */
export const SEARCH_MAX_PER_FILE = 200
/** 一次搜索的总结果上限（service 侧自扛：撞线即取消引擎句柄 → truncated） */
export const SEARCH_MAX_TOTAL = 2000
/** 匹配行预览统一截断（字符数；不用 rg --max-columns，它的输出形态有版本差异） */
export const SEARCH_PREVIEW_MAX = 500
/** 搜索整体超时（已出过结果就 done{truncated}，零结果才 error） */
export const SEARCH_TIMEOUT_MS = 30_000

type Query = Pick<SearchStartParams, 'root' | 'pattern' | 'isRegex' | 'ignoreCase'>

// ---- rg ----

/** 本机 argv 形态（runLocalStream 直接消费，不经 shell） */
export function buildRgArgs(query: Query): string[] {
  const args = [
    '--json',
    '--max-count', String(SEARCH_MAX_PER_FILE),
    '--max-filesize', '2M',
    ...SEARCH_EXCLUDE_DIRS.flatMap((d) => ['-g', `!${d}`])
  ]
  if (query.ignoreCase) args.push('-i')
  if (!query.isRegex) args.push('-F')
  args.push('--', query.pattern, query.root)
  return args
}

/** 远端单命令形态（sh 单引号包裹，与 ComposeService/runtime.ts 同口径） */
export function buildRgCommand(rgPath: string, query: Query): string {
  return shellQuoteAll([rgPath, ...buildRgArgs(query)])
}

// ---- grep（POSIX 保底；BusyBox 可能不认 --null/--exclude-dir，由 service 探测）----

/**
 * @param nul 支持 --null 时输出 `path\0LINE:TEXT`（文件名含冒号也不会切错）；
 *            不支持时输出 `path:LINE:TEXT`，解析用非贪婪正则（限制见 parseGrepLine）
 */
export function buildGrepCommand(query: Query, opts: { nul: boolean }): string {
  return shellQuoteAll(buildGrepArgs(query, opts))
}

/** grep 的 argv 形态（本机 runLocalStream 直接消费，不经 shell 不用 quoting） */
export function buildGrepArgs(query: Query, opts: { nul: boolean }): string[] {
  const args = ['-rnI', '-m', String(SEARCH_MAX_PER_FILE)]
  if (opts.nul) args.push('--null')
  if (query.ignoreCase) args.push('-i')
  if (!query.isRegex) args.push('-F')
  for (const d of SEARCH_EXCLUDE_DIRS) args.push(`--exclude-dir=${d}`)
  args.push('-e', query.pattern, query.root)
  return args
}

/** sh 单引号包裹一整条 argv（' → '\''；与 runtime.ts shellJoinArgv 同款，避免 main/search → container 依赖） */
function shellQuoteAll(argv: string[]): string {
  return argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
}

// ---- 行重组（rg/grep 输出跨 chunk 到，先拼回整行再解析）----

export function createLineAccumulator(push: (line: string) => void): {
  feed: (text: string) => void
  end: () => void
} {
  let buf = ''
  return {
    feed(text) {
      buf += text
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        push(line.endsWith('\r') ? line.slice(0, -1) : line)
      }
    },
    end() {
      if (buf) {
        push(buf.endsWith('\r') ? buf.slice(0, -1) : buf)
        buf = ''
      }
    }
  }
}

// ---- rg --json 解析 ----

interface RgJsonSubmatch {
  start: number
}
interface RgJsonMatch {
  type: 'match'
  data: {
    path: { text?: string; bytes?: string }
    lines: { text?: string; bytes?: string }
    line_number: number
    submatches: RgJsonSubmatch[]
  }
}

/**
 * 解析一行 rg --json 输出。只认 match 消息，其余（begin/end/summary）返回 null。
 * rg 对非法 UTF-8 的路径/行会发 bytes（base64）形态，有损解码成 UTF-8。
 * 非 match 的 JSON、以及根本不是 JSON 的行（理论不该有，stderr 已分流）一律 null。
 */
export function parseRgJsonLine(line: string): SearchMatch | null {
  if (!line.startsWith('{')) return null
  let msg: RgJsonMatch
  try {
    msg = JSON.parse(line) as RgJsonMatch
  } catch {
    return null
  }
  if (msg.type !== 'match' || !msg.data) return null
  const path = decodeRgField(msg.data.path)
  const text = decodeRgField(msg.data.lines)
  if (!path) return null
  return {
    path,
    line: msg.data.line_number ?? 0,
    col: msg.data.submatches?.[0]?.start ?? 0,
    text: truncatePreview(text.replace(/\n$/, ''))
  }
}

function decodeRgField(field: { text?: string; bytes?: string } | undefined): string {
  if (!field) return ''
  if (field.text !== undefined) return field.text
  if (field.bytes !== undefined) return Buffer.from(field.bytes, 'base64').toString('utf8')
  return ''
}

// ---- grep 输出解析 ----

/**
 * nul 形态：`path\0LINE:TEXT` —— 先按 \0 切路径再按第一个 : 切行号，
 * 文件名含冒号（哪怕 `:123:` 这种）也不会错。
 * 非 nul 形态（BusyBox 不支持 --null 时的兜底）：非贪婪 `^(.*?):(\d+):(.*)$` ——
 * 路径里若含 `:数字:` 会切错；这是第三兜底档，接受并在注释里写明。
 * 文件名含换行两种形态都会坏一条结果：接受。
 */
export function parseGrepLine(line: string, opts: { nul: boolean }): SearchMatch | null {
  if (opts.nul) {
    const z = line.indexOf('\0')
    if (z <= 0) return null
    const path = line.slice(0, z)
    const rest = line.slice(z + 1)
    const c = rest.indexOf(':')
    if (c <= 0) return null
    const lineNo = Number(rest.slice(0, c))
    if (!Number.isInteger(lineNo) || lineNo <= 0) return null
    return { path, line: lineNo, col: 0, text: truncatePreview(rest.slice(c + 1)) }
  }
  const m = /^(.*?):(\d+):(.*)$/.exec(line)
  if (!m) return null
  return { path: m[1], line: Number(m[2]), col: 0, text: truncatePreview(m[3]) }
}

// ---- 共用 ----

export function truncatePreview(text: string): string {
  return text.length > SEARCH_PREVIEW_MAX ? text.slice(0, SEARCH_PREVIEW_MAX) : text
}

/** pattern 里含换行/NUL 直接拒（搜索框是单行输入，这是纯防御） */
export function isPatternSafe(pattern: string): boolean {
  return pattern.length > 0 && !/[\r\n\0]/.test(pattern)
}

/** 本机 node 兜底引擎的逐行匹配器（与 agent Go 侧同语义） */
export function createNodeMatcher(query: Pick<Query, 'pattern' | 'isRegex' | 'ignoreCase'>): {
  match: (line: string) => number
  error?: string
} {
  if (query.isRegex) {
    try {
      const re = new RegExp(query.pattern, query.ignoreCase ? 'i' : '')
      return { match: (line) => (re.exec(line)?.index ?? -1) }
    } catch (err) {
      return { match: () => -1, error: `正则无效：${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const needle = query.ignoreCase ? query.pattern.toLowerCase() : query.pattern
  return {
    match: (line) => (query.ignoreCase ? line.toLowerCase() : line).indexOf(needle)
  }
}

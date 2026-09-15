/**
 * 输出关键字高亮：把 IP、日志级别、error/warn 这类片段在终端里标上颜色。
 *
 * 走的全是 xterm 的 **decoration**（`registerMarker` + `registerDecoration`），
 * 一个字都不改写数据流。这一点是刻意的：往输出里插 ANSI 颜色码看着更直接，但
 * 全屏程序（vim / tmux / htop）重绘时会以「我的屏幕是我写的这样」为前提，
 * 被插进去的转义序列会把颜色和光标位置一起搅乱 —— 跟之前那套鼠标模式过滤
 * 是同一类风险。decoration 只影响渲染，程序那边完全不知道。
 *
 * 备用屏还有一个免费的好处：`registerDecoration` 在 alt buffer 激活时**直接
 * 返回 undefined**（xterm typings 里写明的），所以 vim 这类程序里我们根本挂不上
 * 装饰，不需要另写降级逻辑。
 *
 * 扫描策略（性能与正确性都靠它）：
 *  - 扫的是**缓冲区行**而不是原始字节流 —— 字节流里一个 IP 可能被切成两个 chunk；
 *  - 只扫**视口**（行数 = term.rows）。全部输出都会流经视口，所以「写过的行都被
 *    扫过」成立（marker 锚住行，之后滚回去看颜色还在）；而扫整个 scrollback
 *    （上限 10000 行）在 tail -f 下是不可接受的；
 *  - 视口整体位移时按位移量挪动缓存（xterm 的视口就是绝对行上的一个窗口），
 *    内容没变的行直接跳过 —— 既不闪，也不重复建装饰；
 *  - `onWriteParsed`（每帧最多一次）触发 + 200ms debounce 合并高频输出，
 *    `onScroll` 补扫新露出来的行，`onResize` 重排后全部重扫。
 */
import type { IBufferCell, IBufferLine, IDisposable, ITheme, Terminal } from '@xterm/xterm'

/** 配色角色：直接就是 ITheme 的键名（xterm 主题自带 16 色 + bright*） */
export type HighlightRole =
  | 'red'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'cyan'
  | 'brightRed'
  | 'brightBlack'

export interface HighlightRule {
  id: string
  /** 必须带 g 标志（scanText 靠 lastIndex 迭代），扫之前会复位 */
  re: RegExp
  role: HighlightRole
}

/**
 * 内置规则表（用户选的是「只要内置」，所以这里写死、不做编辑界面）。
 *
 * 顺序即优先级：同一段文字被多条命中时靠前的赢。所以日志级别排在通用关键字
 * 之前 —— `ERROR` 应该按级别上色，而不是再被下面的 error 关键字染一遍。
 * 想加规则就加在这一条数组里，别处不用动。
 */
export const HIGHLIGHT_RULES: HighlightRule[] = [
  // ---- 日志级别（只认大写：正文里的 error/done 交给下面的关键字规则）----
  { id: 'level-error', re: /\b(?:ERROR|FATAL|EMERG|ALERT|CRIT|CRITICAL|SEVERE)\b/g, role: 'red' },
  { id: 'level-warn', re: /\b(?:WARN|WARNING)\b/g, role: 'yellow' },
  { id: 'level-info', re: /\b(?:INFO|NOTICE)\b/g, role: 'blue' },
  { id: 'level-debug', re: /\b(?:DEBUG|TRACE|VERBOSE)\b/g, role: 'brightBlack' },
  // ---- 地址 ----
  { id: 'ipv4', re: /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g, role: 'cyan' },
  // 只认 8 组全写、或含 `::` 的压缩写法。不这么写的话 `12:34:56` 这种时间戳
  // 会被当成 IPv6 整条染色 —— 日志里时间戳比 IPv6 常见得多。
  {
    id: 'ipv6-full',
    re: /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![\w:])/g,
    role: 'cyan'
  },
  {
    id: 'ipv6-compressed',
    re: /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?(?![\w:])/g,
    role: 'cyan'
  },
  { id: 'url', re: /https?:\/\/[^\s"'<>()[\]]+/g, role: 'blue' },
  // ---- 通用关键字（大小写不敏感：日志里 Error/error/Failed 都有）----
  {
    id: 'error',
    re: /\b(?:error|errors|failed|failure|fatal|exception|traceback|panic|denied|refused|unreachable|aborted)\b/gi,
    role: 'red'
  },
  {
    id: 'warn',
    re: /\b(?:warn|warns|warning|warnings|deprecated|timeout|timed out|retrying|retry|degraded)\b/gi,
    role: 'yellow'
  },
  {
    id: 'ok',
    re: /\b(?:success|successful|successfully|finished|listening|started|ready|done)\b/gi,
    role: 'green'
  },
  // ---- 状态词（systemctl / docker ps / k8s 状态列与事件、CI、git；failed 走上面的 error）----
  {
    id: 'status-ok',
    re: /\b(?:active|running|healthy|online|succeeded|enabled|available|completed|passed|reachable)\b/gi,
    role: 'green'
  },
  {
    id: 'status-warn',
    re: /\b(?:inactive|dead|stopped|exited|pending|waiting|restarting|suspended|terminating|activating|reloading|refreshing|starting|stopping|paused|zombie|defunct|unknown|queued|skipped|canceled|cancelled|offline|expired|disabled|masked|read-only|progressing|containercreating|podinitializing)\b/gi,
    role: 'yellow'
  },
  {
    id: 'status-err',
    re: /\b(?:unhealthy|evicted|imagepullbackoff|errimagepull|crashloopbackoff|oomkilled|createcontainerconfigerror|progressdeadlineexceeded|nodelost|conflict|corrupted|interrupted)\b/gi,
    role: 'red'
  }
]

export interface TextMatch {
  start: number
  end: number
  rule: HighlightRule
}

/**
 * 在一行文本里找出所有命中（纯函数，方便单测）。
 *
 * 重叠按规则顺序解决：先命中者赢，后来的重叠片段直接丢掉 —— 不做「短匹配覆盖
 * 长匹配」这种猜测，规则表里的顺序就是唯一的优先级。
 */
export function scanText(text: string, rules: HighlightRule[] = HIGHLIGHT_RULES): TextMatch[] {
  if (!text) return []
  const taken: TextMatch[] = []
  for (const rule of rules) {
    // 共享的 g 正则：上次扫到一半退出会留下 lastIndex，每次扫之前必须复位
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(text)) !== null) {
      if (!m[0]) {
        rule.re.lastIndex++ // 零宽匹配：推一格防死循环
        continue
      }
      const start = m.index
      const end = start + m[0].length
      if (taken.some((t) => start < t.end && end > t.start)) continue
      taken.push({ start, end, rule })
    }
  }
  return taken.sort((a, b) => a.start - b.start)
}

/**
 * 读出一行的文本与**逐字符的显示宽度**。
 *
 * 为什么不直接用 `translateToString`：decoration 的 x/width 单位是**格**，
 * 而中文/emoji 一个字符占两格 —— 拿字符下标当格号，行里有中文之后高亮会整体
 * 往左偏。逐格读能同时拿到字符和它占的宽度，两边永远对齐。
 *
 * 宽度数组按**字符串下标**对齐（代理对的两个 code unit 只有第一个带宽度，
 * 第二个记 0），这样 scanText 给的字符下标可以直接查表。
 */
export function buildLineText(
  line: IBufferLine,
  cols: number,
  scratch: IBufferCell
): { text: string; widths: number[] } {
  let text = ''
  const widths: number[] = []
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, scratch)
    if (!cell) break
    const w = cell.getWidth()
    if (w === 0) continue // 宽字符的第二格
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) widths.push(i === 0 ? w : 0)
    text += chars
  }
  // 裁掉尾部空白（同 translateToString(true)）：只裁普通的单格空格，
  // 宽字符后面跟着的空格也照裁，但宽字符本身不会被误伤
  while (text.length && text.endsWith(' ') && widths[widths.length - 1] === 1) {
    text = text.slice(0, -1)
    widths.pop()
  }
  return { text, widths }
}

/** 字符下标 → 格号（前面所有字符的宽度和） */
export function cellXOf(widths: number[], index: number): number {
  let x = 0
  const n = Math.min(index, widths.length)
  for (let i = 0; i < n; i++) x += widths[i]
  return x
}

/** 一段字符占多少格 */
export function cellWidthOf(widths: number[], start: number, end: number): number {
  let w = 0
  const n = Math.min(end, widths.length)
  for (let i = start; i < n; i++) w += widths[i]
  return w
}

/** `#rgb` / `#rrggbb` → [r,g,b]；解析不出来返回 null */
function parseHex(color: string | undefined): [number, number, number] | null {
  if (!color) return null
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  let hex = m[1]
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  const n = parseInt(hex, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

/** 把前景色按比例混进背景色（decoration 只吃 #RRGGBB，没有 alpha，只能自己混） */
export function mixHex(bg: string | undefined, fg: string, ratio: number): string {
  const b = parseHex(bg)
  const f = parseHex(fg)
  if (!b || !f) return fg
  return toHex([0, 1, 2].map((i) => b[i] + (f[i] - b[i]) * ratio) as [number, number, number])
}

/** 一小片底色：压得住但不抢字（前景色本身已经染色了，底色只做「荧光笔」那点强调） */
const TINT_RATIO = 0.1
/** 与 addon-search 同款节奏：onWriteParsed 每帧最多一次，这里再合并 200ms */
const DEBOUNCE_MS = 200

interface RowState {
  text: string
  items: IDisposable[]
}

export class OutputHighlighter {
  private _term: Terminal | null = null
  private _theme: ITheme | null = null
  private _enabled = false
  private _subs: IDisposable[] = []
  private _timer: ReturnType<typeof setTimeout> | null = null
  /** 视口逐行的状态（按视口行号，不是绝对行号 —— 位移时随视口一起挪） */
  private _rows: RowState[] = []
  /** 上一次扫描时视口顶行的绝对行号；-1 表示需要整体重扫 */
  private _top = -1
  private _scratch: IBufferCell | null = null

  attach(term: Terminal): void {
    this._term = term
    this._scratch = term.buffer.active.getNullCell()
    this._subs.push(term.onWriteParsed(() => this._schedule()))
    this._subs.push(term.onScroll(() => this._schedule()))
    this._subs.push(
      term.onResize(() => {
        // 重排会重新折行，列号全变，行内容也跟着变 —— 老老实实全部重扫
        this._reset()
        this._schedule()
      })
    )
  }

  setEnabled(on: boolean): void {
    if (this._enabled === on) return
    this._enabled = on
    if (on) this._schedule()
    else {
      this._cancel()
      this._reset() // 关掉开关时把已经挂上的颜色立刻摘掉
    }
  }

  setTheme(theme: ITheme): void {
    if (this._theme === theme) return
    this._theme = theme
    // 配色变了，已有的装饰颜色全是旧的 —— 全部重挂（不清的话得逐个比对颜色）
    this._reset()
    this._schedule()
  }

  dispose(): void {
    this._cancel()
    for (const s of this._subs) s.dispose()
    this._subs = []
    this._reset()
    this._term = null
    this._scratch = null
  }

  private _cancel(): void {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  private _schedule(): void {
    if (!this._enabled || !this._term || this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this._rescan()
    }, DEBOUNCE_MS)
  }

  private _reset(): void {
    for (const row of this._rows) for (const it of row.items) it.dispose()
    this._rows = []
    this._top = -1
  }

  private _rescan(): void {
    const term = this._term
    const scratch = this._scratch
    if (!this._enabled || !term || !scratch) return
    const buf = term.buffer.active
    // 全屏程序走备用屏：registerDecoration 会返回 undefined，扫了也白扫，
    // 顺手把普通屏上挂的旧装饰摘掉，免得它们盖在新画面上
    if (buf.type === 'alternate') {
      if (this._rows.length) this._reset()
      return
    }

    const rows = term.rows
    const top = buf.viewportY
    /*
     * 视口是绝对行上的一个窗口：视口整体挪 k 行时，缓存整体挪 k 行即可，
     * 内容没变的行完全不用重扫（既不闪，也不重复建装饰）。挪得比视口还大
     * （用户拖滚动条、清屏）就整体重来。
     */
    const shift = this._top < 0 ? NaN : top - this._top
    if (Number.isNaN(shift) || shift < 0 || shift > rows) {
      this._reset()
      this._rows = Array.from({ length: rows }, () => ({ text: '', items: [] }))
    } else if (shift > 0) {
      for (const row of this._rows.splice(0, shift)) {
        for (const it of row.items) it.dispose()
      }
      while (this._rows.length < rows) this._rows.push({ text: '', items: [] })
    } else if (this._rows.length !== rows) {
      while (this._rows.length < rows) this._rows.push({ text: '', items: [] })
      this._rows.length = rows
    }

    // 光标那一行永远要重扫：它正在被追加写入（"ERRO" → "ERROR" 就是靠这个）
    const cursorRow = buf.baseY + buf.cursorY - top
    for (let r = 0; r < rows; r++) {
      const line = buf.getLine(top + r)
      const state = this._rows[r]
      if (!state) continue
      if (!line) {
        if (state.items.length) {
          for (const it of state.items) it.dispose()
          state.items = []
        }
        state.text = ''
        continue
      }
      const { text, widths } = buildLineText(line, term.cols, scratch)
      if (state.text === text && r !== cursorRow) continue // 没变，装饰留着
      for (const it of state.items) it.dispose()
      state.items = this._decorate(term, top + r, text, widths)
      state.text = text
    }
    this._top = top
  }

  private _decorate(
    term: Terminal,
    absLine: number,
    text: string,
    widths: number[]
  ): IDisposable[] {
    const theme = this._theme
    if (!theme || !text) return []
    const matches = scanText(text)
    if (!matches.length) return []
    const cursorAbs = term.buffer.active.baseY + term.buffer.active.cursorY
    const items: IDisposable[] = []
    for (const m of matches) {
      const x = cellXOf(widths, m.start)
      const width = cellWidthOf(widths, m.start, m.end)
      if (width <= 0) continue
      const color = theme[m.rule.role] ?? theme.foreground
      if (!color) continue
      const marker = term.registerMarker(absLine - cursorAbs)
      if (!marker) continue
      const deco = term.registerDecoration({
        marker,
        x,
        width,
        foregroundColor: color,
        backgroundColor: mixHex(theme.background, color, TINT_RATIO)
      })
      if (!deco) {
        marker.dispose()
        continue
      }
      items.push(deco)
    }
    return items
  }
}

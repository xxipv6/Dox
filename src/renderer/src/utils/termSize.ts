/**
 * 建会话时用的终端尺寸种子。
 *
 * 这里原先（以及 connectPane 里）写死 `{cols: 80, rows: 24}`，注释写着「建立后
 * xterm 的 onResize 会立即修正」—— 多数情况下确实会，但它把「pty 的出生尺寸」
 * 交给了一次**事后**的 window-change 来纠正，而事后纠正的前提是对端会响应
 * SIGWINCH。容器/远端里那种「pty 一建好就立刻 attach」的程序（`tmux new -A`、
 * 开机脚本里就起的全屏程序）读到的就是 80×24，之后再来的 window-change 它可能
 * 已经错过了（tmux 只在收到 SIGWINCH 时才重读尺寸），于是它的画面永远只有
 * 24 行 —— 在 50 行的面板里就是「只占一半，下面全空」。
 *
 * 鸡生蛋的地方在于：连接要尺寸，而 xterm 要等会话 id 回来才挂载，此刻没有终端
 * 可问。所以改成用**上一个终端的真实尺寸**当种子 —— 同一个窗口里新开的标签
 * 尺寸基本一致，等于一出生就对。拿不到（本次启动的第一个会话）才退回 80×24，
 * 也就是跟原来一样。
 *
 * 注意只记**真的 fit 成功过**的尺寸（见 TerminalPanel 的 safeFit）：隐藏标签
 * 挂载时尺寸是退化的，不能让它把种子写坏。
 */

export interface TermSize {
  cols: number
  rows: number
}

/** VT100 以来的经典默认值，也是 xterm 构造时的初值 */
const FALLBACK: TermSize = { cols: 80, rows: 24 }

let last: TermSize | null = null

export function seedTermSize(): TermSize {
  return last ?? FALLBACK
}

export function rememberTermSize(cols: number, rows: number): void {
  last = { cols, rows }
}

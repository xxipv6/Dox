/**
 * 平铺网格的列数计算（纯函数，好单测）。
 *
 * 目标是**接近方阵**：4 个标签铺成 2×2，而不是「一排放得下就排一排」。
 * 一排放得下的方案（1400px 下 4 个标签 = 4 列）格子只有 350px 宽 ≈ 43 列，
 * 而 2×2 每格近 700px ≈ 85 列 —— 看日志的差别是「能读」和「得横向滚」。
 * 所以先按 ceil(sqrt(n)) 取理想列数，再用可用宽度和标签数夹一次。
 *
 * 为什么还要夹「最小格子宽度」：
 *
 * `TerminalPanel.safeFit()` 对小于 120×60 的容器**直接 return**（不 fit、也不
 * 写尺寸种子）—— 那是为了挡住隐藏标签的 0 尺寸、以及退化尺寸（实测 11x5）把
 * pty 缩坏。代价是：格子一旦被压到那两条线以下，它就会**静默停在旧尺寸上**
 * （正是「xterm 停在 80x24」那一类故障：界面看着好好的，pty 那边尺寸是错的）。
 *
 * 所以这里的规矩是：宁可让网格**纵向滚动**，也不把格子压小。高度不够时由
 * CSS（`.terminal-stack.tiled` 的 `grid-auto-rows` 下限 + `overflow: auto`）
 * 去滚，不在这里缩。
 */

/**
 * 单格最小宽度（像素）。
 *
 * 取 320 而不是贴着 safeFit 的 120：那 120 是「再小就要坏了」的硬底线，
 * 不是「还能用」的标准 —— 320px 在默认字号下约 40 列，日志和 `top` 都读得下去。
 */
export const MIN_TILE_WIDTH = 320
/** 单格最小高度（像素）。同理，留给 CSS 的 `--tile-min-h`，保证下限只有一个出处 */
export const MIN_TILE_HEIGHT = 200

export interface TileGrid {
  cols: number
  rows: number
  /**
   * 最后一行恰好只剩一个格子、且不止一列时，让那一个横跨整行。
   *
   * 图的就是 3 个标签这个正经场景（日志 / 配置 / 进程）：2 列网格里第 4 格是空
   * 的，白占四分之一屏。拉通之后前两格并排、第三个独占一行，屏幕一点不浪费。
   */
  spanLast: boolean
}

export function tileGrid(
  count: number,
  availWidth: number,
  minCellWidth: number = MIN_TILE_WIDTH
): TileGrid {
  if (count <= 0) return { cols: 1, rows: 0, spanLast: false }
  const ideal = Math.ceil(Math.sqrt(count))
  // 还没量到宽度（0）或被除出 NaN 时按最保守的一列来：宁可纵向排一列，
  // 也不能算出 NaN 列让 CSS 直接失效
  const byWidth = Number.isFinite(availWidth) ? Math.floor(availWidth / minCellWidth) : 0
  const cols = Math.max(1, Math.min(count, ideal, byWidth))
  const rows = Math.ceil(count / cols)
  const inLastRow = count - (rows - 1) * cols
  return { cols, rows, spanLast: cols > 1 && inLastRow === 1 }
}

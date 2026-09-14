/**
 * 标签栏在标签多时自动收窄的判定（纯函数，好单测）。
 *
 * 为什么用「个数 × 最小可读宽度 vs 可用宽度」估算，而不是先量一遍 DOM 再决定：
 * 收窄本身会改变标签宽度，量出来再决定就形成了反馈环 —— 溢出 → 收窄 → 不收窄了
 * → 溢出 → … 来回抖。按个数估算是单向的，不会抖，也好写测试。
 *
 * 收窄只是「每个标签最多占多宽」（CSS 里挂 .compact 后改 max-width），
 * 收不下时靠右边的溢出清单（▾）兜底 —— 它是不是显示是 DOM 实测的，
 * 那条路径没有反馈环：显示它只会让可用宽度更小，不会让它自己消失。
 */

/**
 * 收窄前单个标签至少要占的宽度（像素）。
 *
 * 状态点 + 三四个汉字 + 关闭键 ≈ 130px；取 140 是「再挤就该收窄了」的线。
 * 1151px 的标签栏按这个算能并排 8 个，第 9 个开始收窄。
 */
export const TAB_MIN_WIDTH = 140

/** 是否需要收窄（标签个数 × 最小宽度 超出可用宽度） */
export function tabbarCompact(count: number, availWidth: number): boolean {
  if (count <= 0 || !Number.isFinite(availWidth) || availWidth <= 0) return false
  return count * TAB_MIN_WIDTH > availWidth
}

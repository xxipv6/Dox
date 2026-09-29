/**
 * 分组名的读取口径：显式创建的分组（含空组）存在 localStorage `dox-groups`，
 * 由 SessionSidebar 维护。DeviceDialog 的分组候选也要这份（空组也是已存在的组），
 * 故抽出来共用 —— 各读各的会在某一边改 key 时悄悄分叉。
 */
const GROUPS_KEY = 'dox-groups'

/** 显式创建的分组名单（含空分组）；没有/解析失败都给空数组 */
export function readKnownGroups(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

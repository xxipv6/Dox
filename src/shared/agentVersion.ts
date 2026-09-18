/**
 * 应用内置的 dox-agent 版本。
 *
 * 与 agent/main.go 的 `var version` 保持同步 —— 升 agent 版本时两边一起改。
 * 渲染层用它识别「远端/容器里的助手过旧」（新应用 + 老助手），
 * 给出升级引导而不是把 unknown method 原文糊给用户。
 */
export const BUNDLED_AGENT_VERSION = '0.7.4'

/**
 * 容器**文件面板**（fs_list/fs_read/fs_write…整套 fs_*）要求的最低 agent 版本。
 *
 * 必须与 BUNDLED_AGENT_VERSION 分开：升内置版本时若把面板门槛也跟着抬，
 * 老版本助手（fs_* 一应俱全）的容器整个面板都会被「过旧」横幅关掉 ——
 * 只有新方法（如 fs_search）才真需要新版本，那类门槛放这里下面这种常量。
 */
export const FS_MIN_AGENT_VERSION = '0.6.8'

/** fs_search（全文搜索）要求的最低 agent 版本（SearchService 与渲染层共用，别散落字面量） */
export const FS_SEARCH_MIN_AGENT_VERSION = '0.7.0'

/** 简易 semver 比较：a < b 返回 true（只认 x.y.z 数字段，我们的版本号自己控制） */
export function agentVersionOlder(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  }
  return false
}

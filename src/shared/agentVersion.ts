/**
 * 应用内置的 dox-agent 版本。
 *
 * 与 agent/main.go 的 `var version` 保持同步 —— 升 agent 版本时两边一起改。
 * 渲染层用它识别「远端/容器里的助手过旧」（新应用 + 老助手），
 * 给出升级引导而不是把 unknown method 原文糊给用户。
 */
export const BUNDLED_AGENT_VERSION = '0.3.0'

/** 简易 semver 比较：a < b 返回 true（只认 x.y.z 数字段，我们的版本号自己控制） */
export function agentVersionOlder(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  }
  return false
}

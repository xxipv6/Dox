/**
 * 更新公告数据（「本次更新了什么」）。
 *
 * 为什么是应用内数据而不是 updater 的 releaseNotes：主更新源是 generic 镜像，
 * 它只解析 latest.yml，而 yml 里没有 notes 字段 —— releaseNotes 恒为 undefined。
 * 随包编译的这份数据离线可用、两源一致。
 *
 * 数据本体在 whatsnew.json（同目录）：CI 发版时把首条作为 release 资产上传
 * （scripts/dump-whatsnew.mjs → gh release upload），旧版本发现新版时就能
 * 拉到新版的条目 —— 更新**前**展示更新内容（见 main/updater.ts 的
 * fetchReleaseNotes）。scripts/build-agent.mjs 校验「首条版本 === package.json
 * version」，忘写即构建失败。
 *
 * 维护规则：新版本发版前往数组**头部**加一条，version 与 package.json 对齐。
 */
import entries from './whatsnew.json'

export interface WhatsNewEntry {
  version: string
  notes: string[]
}

export const WHATS_NEW: WhatsNewEntry[] = entries

/** 查某个版本的公告条目；没有对应条目返回 undefined */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((w) => w.version === version)
}

/** 设置「关于」页「查看更新内容」的载荷 */
export interface WhatsNewPayload {
  version: string
  notes: string[]
}

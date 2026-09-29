/**
 * 更新公告数据（「本次更新了什么」）。
 *
 * 为什么是应用内数据而不是 updater 的 releaseNotes：主更新源是 generic 镜像，
 * 它只解析 latest.yml，而 yml 里没有 notes 字段 —— releaseNotes 恒为 undefined。
 * 随包编译的这份数据离线可用、两源一致，代价是每次发版要手工加一条 ——
 * scripts/build-agent.mjs 会校验「首条版本 === package.json version」，忘写即构建失败。
 *
 * 维护规则：新版本发版前往数组**头部**加一条，version 与 package.json 对齐。
 */
export interface WhatsNewEntry {
  version: string
  notes: string[]
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '0.1.8',
    notes: [
      '设备分组：侧栏分组管理，设备可按组折叠/归置',
      '服务器互传：两台服务器之间直接 P2P 传文件，不经本机中转',
      '镜像管理：查看/清理远端 Docker 镜像',
      '远程目录监听：远端目录变化实时刷新文件面板'
    ]
  }
]

/** 查某个版本的公告条目；没有对应条目返回 undefined（该版本不弹公告） */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((w) => w.version === version)
}

/** whatsnew:get 的返回载荷（非 null 时渲染层弹公告） */
export interface WhatsNewPayload {
  version: string
  notes: string[]
}

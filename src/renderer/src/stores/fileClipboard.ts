import { ref } from 'vue'

/**
 * 文件面板剪贴板是应用级状态，而不是某个 FileExplorer 实例的局部状态。
 * 标签切换会销毁/重建面板；放在模块作用域才能让同一会话的复制内容跨标签
 * 与目录导航继续可用。
 */
export const panelClipboard = ref<{ key: string; paths: string[] } | null>(null)

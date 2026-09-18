import { ref } from 'vue'
import { useConfirmStore } from './confirm'

/**
 * 文件面板剪贴板是应用级状态，而不是某个 FileExplorer 实例的局部状态。
 * 标签切换会销毁/重建面板；放在模块作用域才能让同一会话的复制内容跨标签
 * 与目录导航继续可用。
 *
 * `key`（会话|容器）相同的粘贴走同面板快路（就地 cp / 本机复制）；
 * 不同的走跨面板粘贴（远端→本机静默下载 / 本机→远端上传 / 远端A→远端B 互传），
 * `isLocal` 就是给跨面板方向判断用的。
 */
export const panelClipboard = ref<{ key: string; paths: string[]; isLocal: boolean } | null>(null)

/**
 * P2P 直传授权：本次运行内只问一次。
 * 授权后互传会在两台机器上临时装一次性免密密钥（用完即删）走 A→B 直连；
 * 拒绝则本次运行都经本机中转（不弹第二次）。
 */
let p2pConsent: 'ask' | 'allow' | 'deny' = 'ask'

export async function askP2pConsent(): Promise<boolean> {
  if (p2pConsent !== 'ask') return p2pConsent === 'allow'
  const yes = await useConfirmStore().ask(
    '跨机直传（P2P）：在两台机器上临时安装一次性免密密钥（传完即删），让源机直连目标机满速传输，流量不经过本机。\n\n允许？（拒绝则经本机中转，本次运行内记住选择）'
  )
  p2pConsent = yes ? 'allow' : 'deny'
  return yes
}


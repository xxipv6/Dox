import { assertContainerTarget, shellJoinArgv } from '../container/runtime'

/** 0.9.6+：agent 删除自身并输出 JSON，适用于没有 shell 的容器。 */
export const HOST_AGENT_UNINSTALL_COMMAND = `/bin/sh -c '~/.dox/dox-agent uninstall'`

/** 只删除当前用户 HOME 下的 Dox 私有目录，不接触系统目录。 */
export const HOST_UNINSTALL_COMMAND = `/bin/sh -c 'rm -rf -- "$HOME/.dox"'`

export function localContainerAgentUninstallArgs(containerName: string): string[] {
  return ['exec', assertContainerTarget(containerName), '/tmp/dox-agent', 'uninstall']
}

export function remoteContainerAgentUninstallCommand(binary: string, containerName: string): string {
  return shellJoinArgv([binary, ...localContainerAgentUninstallArgs(containerName)])
}

/** 老 agent 的回退：本机不经 shell 拼接 runtime/容器名。 */
export function localContainerUninstallArgs(containerName: string): string[] {
  return ['exec', assertContainerTarget(containerName), 'sh', '-c', 'rm -f -- /tmp/dox-agent']
}

export function remoteContainerUninstallCommand(binary: string, containerName: string): string {
  return shellJoinArgv([binary, ...localContainerUninstallArgs(containerName)])
}

/** 仅“不认识 uninstall”允许走旧版回退；权限/IO 等失败不能吞成成功。 */
export function isAgentUninstallUnsupported(err: unknown): boolean {
  const e = err as { message?: string; stderr?: string; stdout?: string }
  return /unknown subcommand:\s*uninstall/i.test([e?.message, e?.stderr, e?.stdout].filter(Boolean).join('\n'))
}

/** 成功退出之外还必须有 A 域约定的 {"ok":true} 回执，空对象/false 都状态未知。 */
export function assertAgentUninstallReceipt(stdout: string): void {
  let receipt: unknown
  try {
    receipt = JSON.parse(stdout.trim())
  } catch {
    throw new Error('agent uninstall 未返回成功回执，删除状态未知')
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      (receipt as { ok?: unknown }).ok !== true) {
    throw new Error('agent uninstall 未确认 ok=true，删除状态未知')
  }
}

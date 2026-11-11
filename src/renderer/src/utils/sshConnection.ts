import type { SshSessionConfig, TermSize } from '@shared/types'

export interface SshConnectionTab {
  savedSessionId?: string
  config: SshSessionConfig | null
}

export type SshConnectionRequest =
  | { kind: 'saved'; savedSessionId: string; term: TermSize }
  | { kind: 'temporary'; config: SshSessionConfig; term: TermSize }

/** saved tab 只凭 id 让主进程解析凭证；临时标签才使用本次表单提交的完整配置。 */
export function planSshConnection(tab: SshConnectionTab, term: TermSize): SshConnectionRequest {
  if (tab.savedSessionId) {
    return { kind: 'saved', savedSessionId: tab.savedSessionId, term }
  }
  if (!tab.config) throw new Error('临时 SSH 会话缺少连接配置')
  return { kind: 'temporary', config: tab.config, term }
}

export function presentSshConnectionError(
  text: string,
  isSaved: boolean,
  decryptFailedMarker: string
): { message: string; decryptFailed: boolean } {
  const decryptFailed = isSaved && text.includes(decryptFailedMarker)
  return {
    message: decryptFailed ? text.replace(decryptFailedMarker, '').trim() : text,
    decryptFailed
  }
}

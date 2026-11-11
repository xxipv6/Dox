export interface ContainerOrigin {
  originSavedId?: string
  /** 未保存 SSH 用 tmp: 身份；找不到稳定身份时退到运行期 session: id，绝不冒充本机 */
  originDeviceKey?: string
}

export interface ContainerTarget extends ContainerOrigin {
  sessionId: string
  chain?: string[]
}

export interface ContainerRequestKey {
  generation: number
  key: string
}

export interface ContainerOriginTab {
  kind: 'ssh' | 'local' | 'container'
  savedSessionId?: string
  config?: { host: string; port: number; username: string } | null
  container?: ContainerOrigin & { parentSessionId?: string }
}

export function containerTargetKey(sessionId: string, chain?: string[]): string {
  return JSON.stringify([sessionId, chain ?? []])
}

export function isCurrentContainerRequest(
  request: ContainerRequestKey,
  current: ContainerRequestKey
): boolean {
  return request.generation === current.generation && request.key === current.key
}

/** 从当前标签提取容器项目根身份；敏感认证字段不会进入该视图。 */
export function containerOriginForTab(tab: ContainerOriginTab, sessionId: string | null): ContainerOrigin {
  if (tab.kind === 'local') return { originSavedId: undefined, originDeviceKey: '@local' }
  if (tab.kind === 'container') {
    return {
      originSavedId: tab.container?.originSavedId,
      originDeviceKey: tab.container?.originDeviceKey
    }
  }
  if (tab.savedSessionId) return { originSavedId: tab.savedSessionId }
  if (tab.config) {
    return { originDeviceKey: `tmp:${tab.config.username}@${tab.config.host}:${tab.config.port}` }
  }
  return { originDeviceKey: sessionId ? `session:${sessionId}` : undefined }
}

export function containerDeviceBase(target: ContainerTarget, isLocal: boolean): string {
  if (target.originSavedId) return `saved:${target.originSavedId}`
  if (isLocal) return '@local'
  return target.originDeviceKey ?? `session:${target.sessionId}`
}

/** originSavedId 同时用于普通 SSH 的项目根身份，不能再单独代表直连传输所有权。 */
export function usesContainerTransport(container: { originSavedId?: string; usesTransport?: boolean }): boolean {
  return container.usesTransport === true
}

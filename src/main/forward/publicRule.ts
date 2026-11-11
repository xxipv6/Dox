import type { ForwardRule } from '../../shared/types'

/**
 * IPC 的唯一出口：内部 server/socket/handler/Promise 永远不按名称碰运气剥离。
 * structuredClone 同时保证每次返回独立快照，并在未来误放不可克隆字段时尽早失败。
 */
export function toPublicRule(rule: ForwardRule): ForwardRule {
  const dto: ForwardRule = {
    id: rule.id,
    sessionId: rule.sessionId,
    type: rule.type,
    listenHost: rule.listenHost,
    listenPort: rule.listenPort,
    targetHost: rule.targetHost,
    targetPort: rule.targetPort,
    status: rule.status,
    ...(rule.container !== undefined ? { container: rule.container } : {}),
    ...(rule.originContainer !== undefined ? { originContainer: rule.originContainer } : {}),
    ...(rule.error !== undefined ? { error: rule.error } : {})
  }
  return structuredClone(dto)
}

import type { SessionStatus } from '@shared/types'

export interface BufferedTransportStatus {
  status: SessionStatus
  error?: string
}

export type TransportResolution =
  | { action: 'ready' }
  | { action: 'disconnect'; error: string }

/** connectTransport 返回后，同时结算早到状态与当前消费者。 */
export function resolveTransportConnection(
  buffered: BufferedTransportStatus | undefined,
  hasConsumer: boolean
): TransportResolution {
  if (buffered?.status === 'closed' || buffered?.status === 'error') {
    return { action: 'disconnect', error: buffered.error || '连接已断开' }
  }
  if (!hasConsumer) return { action: 'disconnect', error: '连接已取消' }
  return { action: 'ready' }
}

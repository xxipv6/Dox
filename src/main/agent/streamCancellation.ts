/** 与 TransferManager 的取消哨兵同文案；放在共享层避免 agentStream 循环依赖。 */
export const STREAM_CANCELED = '__transfer_canceled__'

export type RegisterStreamCancel = (cancel: () => void) => () => void

/**
 * 分块/归档流共用取消控制：先中断本地等待，远端 abort 只由 cancel 触发一次，
 * 正常完成时 interrupted 也有 rejection handler，不遗留未处理拒绝。
 */
export function createStreamCancellation(
  isCanceled: () => boolean,
  registerCancel?: RegisterStreamCancel,
  remoteAbort?: () => Promise<unknown>
) {
  let canceled = false
  let reject!: (err: Error) => void
  const interrupted = new Promise<never>((_resolve, rej) => { reject = rej })
  void interrupted.catch(() => undefined)
  const cancel = (): void => {
    if (canceled) return
    canceled = true
    reject(new Error(STREAM_CANCELED))
    if (remoteAbort) void remoteAbort().catch(() => undefined)
  }
  const dispose = registerCancel?.(cancel) ?? (() => undefined)
  const check = (): void => {
    if (isCanceled()) cancel()
    if (canceled) throw new Error(STREAM_CANCELED)
  }
  const wait = <T>(pending: Promise<T>): Promise<T> => {
    check()
    return Promise.race([pending, interrupted])
  }
  return { check, wait, dispose, cancelled: () => canceled }
}

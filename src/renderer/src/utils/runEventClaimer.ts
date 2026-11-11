/**
 * invoke 返回前，主进程已经可能推送流式事件。这里用本地 operation token
 * 标记“有启动尚未认领”，按事件里的真实 runId 暂存，claim 后由原消费者回放。
 */
export class RunEventClaimer<E> {
  private nextOperation = 0
  private readonly pending = new Set<number>()
  private readonly claimed = new Set<string>()
  private unclaimed: { id: string; event: E }[] = []

  constructor(private readonly eventId: (event: E) => string) {}

  begin(): number {
    const operation = ++this.nextOperation
    this.pending.add(operation)
    return operation
  }

  claim(operation: number, id: string): E[] {
    if (!this.pending.delete(operation)) return []
    this.claimed.add(id)
    const events = this.unclaimed.filter((item) => item.id === id).map((item) => item.event)
    this.unclaimed = this.unclaimed.filter((item) => item.id !== id)
    if (this.pending.size === 0) this.unclaimed = []
    return events
  }

  abort(operation: number): void {
    this.pending.delete(operation)
    if (this.pending.size === 0) this.unclaimed = []
  }

  release(id: string): void {
    this.claimed.delete(id)
    this.unclaimed = this.unclaimed.filter((item) => item.id !== id)
  }

  accept(event: E, consume: (event: E) => void): boolean {
    const id = this.eventId(event)
    if (this.claimed.has(id)) {
      consume(event)
      return true
    }
    // 没有启动在途时，未知 id 就是旧 run 的迟到事件，必须丢弃。
    if (this.pending.size === 0) return false
    this.unclaimed.push({ id, event })
    // 只保护 invoke 尚未返回的短窗口；极端事件洪峰下保留最新事件（含结局），
    // 不让未知 runId 在 renderer 内无限积累。
    if (this.unclaimed.length > 1000) this.unclaimed.shift()
    return false
  }
}

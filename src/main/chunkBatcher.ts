/**
 * 终端输出批处理器：把高频小 chunk 合并成少量 IPC 消息。
 *
 * ssh2 / node-pty 的 data 事件是按网络包触发的，`cat` 一个大文件时每秒几千个
 * chunk —— 原先每个 chunk 都是一条独立的结构化克隆 IPC，主进程 CPU 和 IPC
 * 带宽全烧在信封上。这里按「4ms 或 64KB」合并：交互场景 4ms 延迟无感，
 * 刷屏场景消息数掉一到两个数量级。
 *
 * 两个语义保证：
 * - **保序**：同一 batcher 喂进来的字节严格按调用顺序拼接（stdout/stderr 共用
 *   一个 batcher，本来就是发同一通道，事件循环顺序即到达顺序）。
 * - **不丢尾**：会话 exit/close 前必须调一次 flush()，否则最后几毫秒的输出
 *   会跟着定时器一起进坟墓。
 */

/** 交互延迟与合并收益的平衡点：4ms 低于任何可感知阈值 */
const FLUSH_MS = 4
/** 单条 IPC 的目标上限：刷屏时攒到这个体量立刻发，不等定时器 */
const FLUSH_BYTES = 64 * 1024

export interface ChunkBatcher {
  push(chunk: Buffer): void
  /** 立即把攒下的字节发出去（exit/close 前必须调） */
  flush(): void
  /** 停掉定时器（会话销毁时调用，不拖累进程退出） */
  dispose(): void
}

export function createChunkBatcher(send: (data: Buffer) => void): ChunkBatcher {
  let parts: Buffer[] = []
  let size = 0
  let timer: NodeJS.Timeout | null = null

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (size === 0) return
    const data = parts.length === 1 ? parts[0] : Buffer.concat(parts, size)
    parts = []
    size = 0
    send(data)
  }

  const arm = (): void => {
    if (timer !== null) return
    timer = setTimeout(flush, FLUSH_MS)
    // 不拖住进程退出；退出路径另有 dispose/flush
    timer.unref?.()
  }

  return {
    push(chunk: Buffer): void {
      if (chunk.length === 0) return
      parts.push(chunk)
      size += chunk.length
      if (size >= FLUSH_BYTES) flush()
      else arm()
    },
    flush,
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      parts = []
      size = 0
    }
  }
}

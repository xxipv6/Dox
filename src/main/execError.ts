/**
 * 「跑一条命令」这件事的公共错误模型。
 *
 * 原先它叫 RemoteCommandError、住在 ssh/ 下面，因为当时只有远端这一条路。
 * 加上本机容器之后，同一套语义（失败原因 + 两路输出 + 退出码）远端和本地都要用，
 * 而 docker 的错误分类**只看输出文本**、根本不关心命令跑在哪儿 —— 所以提到
 * 传输之上，让两条路复用同一个错误对象，`outputsOf` 也就能一视同仁。
 */

export type ExecFailure =
  /** 命令跑完了，退出码非 0 */
  | 'exit'
  /** 超时，通道已被强制关闭 */
  | 'timeout'
  /** 通道/进程本身出错（连接断了等） */
  | 'channel'
  /** 输出超过上限，已截断 */
  | 'truncated'
  /** 可执行文件不存在（本地路径专用：PATH 里没有 docker / podman） */
  | 'spawn'

export class CommandError extends Error {
  constructor(
    message: string,
    readonly failure: ExecFailure,
    /** null = 没收到退出码（少见）；负数 = 被信号杀死（-signum） */
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

/** 从 CommandError 里安全取出两路输出，供调用方做错误分类 */
export function outputsOf(err: unknown): { stdout: string; stderr: string; code: number | null } {
  if (err instanceof CommandError) {
    return { stdout: err.stdout, stderr: err.stderr, code: err.code }
  }
  return { stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null }
}

/** 错误的首行非空内容，用来当一句话的失败原因 */
export function firstLine(text: string, max = 200): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

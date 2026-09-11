/** zmodem.js 无官方类型，按实际用到的 API 面手写声明 */
declare module 'zmodem.js' {
  export interface ZFileDetails {
    name: string
    size?: number
    mtime?: Date
    files_remaining?: number
    bytes_remaining?: number
  }

  /** 接收侧：远端发来的单个文件要约 */
  export interface ZOffer {
    get_details(): ZFileDetails
    accept(opts?: { on_input?: (payload: Uint8Array) => void }): Promise<unknown>
    skip(): void
  }

  /** 发送侧：要约被接受后的单文件传输句柄 */
  export interface ZTransfer {
    send(data: Uint8Array | number[]): void
    end(data?: Uint8Array | number[]): Promise<void>
    get_offset(): number
  }

  export interface ZSession {
    type: 'send' | 'receive'
    on(event: 'offer', cb: (offer: ZOffer) => void): void
    on(event: 'session_end', cb: () => void): void
    on(event: string, cb: (...args: never[]) => void): void
    start(): Promise<unknown>
    close(): Promise<void>
    /** 中止协议会话（会触发 session_end）。已中止时调用会抛错，需自行判 aborted() */
    abort(): void
    aborted(): boolean
    send_offer(params: {
      name: string
      size: number
      mtime?: number | Date
      files_remaining?: number
      bytes_remaining?: number
    }): Promise<ZTransfer | undefined>
  }

  export interface ZDetection {
    confirm(): ZSession
    deny(): void
  }

  export class Sentry {
    constructor(opts: {
      to_terminal: (octets: number[]) => void
      sender: (octets: number[]) => void
      on_detect: (detection: ZDetection) => void
      on_retract: () => void
    })
    consume(input: number[] | Uint8Array | ArrayBuffer): void
  }

  /*
   * 运行时是 CJS 且用 Object.assign(module.exports, …) 挂导出 ——
   * 打包器能静态解出 named exports，Node 原生 ESM 不能（cjs-module-lexer
   * 认不出 Object.assign）。所以消费侧走 default 导入再解构，
   * 这样打包产物和 Node 直跑（单测）两条路都通。
   */
  const _default: { Sentry: typeof Sentry }
  export default _default
}

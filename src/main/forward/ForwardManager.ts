import { randomUUID } from 'node:crypto'
import net from 'node:net'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { ForwardRule, ForwardRuleInput } from '../../shared/types'

interface InternalRule extends ForwardRule {
  /** 本地转发的 TCP server */
  server?: net.Server
  /** 本地转发已建立的连接：停止时必须主动销毁，否则 close() 永不回调 */
  sockets?: Set<net.Socket>
  /** 远程转发在 client 上注册的 tcp connection 处理器 */
  tcpHandler?: (info: TcpConnectionDetails, accept: () => ClientChannel) => void
  /**
   * 正在进行中的停止操作。重连后要重新监听同一端口，必须先等旧监听真正关闭，
   * 否则会撞 EADDRINUSE —— 断线重连只要够快（1s 退避）就会踩到。
   */
  stopPromise?: Promise<void>
}

/**
 * 端口转发管理（等效 ssh -L / ssh -R）：
 * - local：本机起 TCP 监听，每个入站连接用 forwardOut 经 SSH 通道转发到目标
 * - remote：在远端绑定端口（requestForward），入站连接经 SSH 回传到本地目标
 * 规则绑定会话，会话断开时其规则自动停止。
 */
export class ForwardManager {
  private rules = new Map<string, InternalRule>()

  constructor(
    private readonly getClient: (sessionId: string) => Client | undefined,
    private readonly onUpdate: (rules: ForwardRule[]) => void
  ) {}

  list(): ForwardRule[] {
    return [...this.rules.values()].map(({ server: _s, tcpHandler: _h, ...r }) => r)
  }

  async add(input: ForwardRuleInput): Promise<ForwardRule> {
    const client = this.getClient(input.sessionId)
    if (!client) throw new Error('会话不存在或已断开')

    const rule: InternalRule = {
      id: randomUUID(),
      listenHost: input.listenHost || '127.0.0.1',
      status: 'stopped',
      ...input
    }
    this.rules.set(rule.id, rule)

    try {
      if (rule.type === 'local') await this.startLocal(rule, client)
      else await this.startRemote(rule, client)
      rule.status = 'active'
    } catch (err) {
      rule.status = 'error'
      rule.error = (err as Error).message
    }
    this.emit()
    return this.snapshot(rule)
  }

  async remove(id: string): Promise<void> {
    const rule = this.rules.get(id)
    if (!rule) return
    await this.stop(rule)
    this.rules.delete(id)
    this.emit()
  }

  /** 会话断开时停止其全部转发规则（保留记录，状态置为 stopped） */
  stopBySession(sessionId: string): void {
    let changed = false
    for (const rule of this.rules.values()) {
      if (rule.sessionId === sessionId && rule.status === 'active') {
        // 必须先 await 停止再改状态：否则监听端口可能仍在 listen，
        // 同端口重新添加必然 EADDRINUSE，只有重启应用才能恢复
        const promise = this.stop(rule).then(() => {
          rule.status = 'stopped'
          this.emit()
        })
        rule.stopPromise = promise
        void promise
        changed = true
      }
    }
    if (changed) this.emit()
  }

  /**
   * 会话重连成功后，把它的转发规则按原参数重新建立。
   * 断开时 stopBySession 只把状态置成 stopped、记录一直保留着，
   * 这里直接复用 —— 隧道必须自己恢复，否则用户以为它还开着。
   */
  async restartBySession(sessionId: string): Promise<void> {
    const client = this.getClient(sessionId)
    if (!client) return

    const pending = [...this.rules.values()].filter(
      (rule) => rule.sessionId === sessionId && rule.status !== 'active'
    )
    if (pending.length === 0) return

    for (const rule of pending) {
      // 等旧监听彻底关闭，否则同一端口重新 listen 会 EADDRINUSE
      if (rule.stopPromise) {
        await rule.stopPromise.catch(() => undefined)
        rule.stopPromise = undefined
      }
      rule.error = undefined
      try {
        if (rule.type === 'local') await this.startLocal(rule, client)
        else await this.startRemote(rule, client)
        rule.status = 'active'
      } catch (err) {
        rule.status = 'error'
        rule.error = (err as Error).message
      }
    }
    this.emit()
  }

  /** 本地转发：net.createServer → forwardOut 管道 */
  private startLocal(rule: InternalRule, client: Client): Promise<void> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<net.Socket>()
      rule.sockets = sockets

      const server = net.createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        client.forwardOut(rule.listenHost, rule.listenPort, rule.targetHost, rule.targetPort, (err, stream) => {
          if (err) {
            socket.destroy()
            return
          }
          socket.pipe(stream).pipe(socket)
          socket.on('error', () => stream.destroy())
          stream.on('error', () => socket.destroy())
        })
      })

      // 持久监听而非 once：监听中的 server 后续仍可能 emit error（EMFILE 等），
      // 那时没有监听者的话 Node 会直接抛出并崩掉主进程
      let listening = false
      server.on('error', (err: Error) => {
        if (!listening) reject(err)
        else console.warn(`[forward] 本地转发 ${rule.listenHost}:${rule.listenPort} 错误: ${err.message}`)
      })
      server.listen(rule.listenPort, rule.listenHost, () => {
        listening = true
        resolve()
      })
      rule.server = server
    })
  }

  /** 远程转发：forwardIn 绑定远端端口，tcp connection 事件按端口分发 */
  private startRemote(rule: InternalRule, client: Client): Promise<void> {
    return new Promise((resolve, reject) => {
      client.forwardIn(rule.listenHost, rule.listenPort, (err: Error | undefined) => {
        if (err) return reject(err)

        const handler = (info: TcpConnectionDetails, accept: () => ClientChannel): void => {
          if (info.destPort !== rule.listenPort || info.destIP !== rule.listenHost) return
          const stream = accept()
          const socket = net.connect(rule.targetPort, rule.targetHost)
          stream.pipe(socket).pipe(stream)
          stream.on('error', () => socket.destroy())
          socket.on('error', () => stream.destroy())
        }
        client.on('tcp connection', handler)
        rule.tcpHandler = handler
        resolve()
      })
    })
  }

  private async stop(rule: InternalRule): Promise<void> {
    if (rule.server) {
      const server = rule.server
      // 先销毁所有已建立的连接：net.Server.close() 只是停止接受新连接，
      // 回调要等所有现存连接结束才触发。用户只要通过 -L 挂过一条长连接
      // （浏览器 keep-alive、数据库连接），不销毁就会永远卡住 here，
      // 调用方（IPC remove）永不返回，端口也一直占着。
      for (const socket of rule.sockets ?? []) socket.destroy()
      rule.sockets?.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 兜底：极少数情况下 close 回调仍可能不来，不能让调用方挂死
        setTimeout(resolve, 1000).unref?.()
      })
      rule.server = undefined
    }
    if (rule.tcpHandler) {
      const client = this.getClient(rule.sessionId)
      if (client) {
        client.off('tcp connection', rule.tcpHandler)
        // 解除远端端口绑定（尽力而为，会话可能已断开）
        await new Promise<void>((resolve) => {
          client.unforwardIn(rule.listenHost, rule.listenPort, () => resolve())
        })
      }
      rule.tcpHandler = undefined
    }
  }

  private snapshot(rule: InternalRule): ForwardRule {
    const { server: _s, tcpHandler: _h, ...r } = rule
    return r
  }

  private emit(): void {
    this.onUpdate(this.list())
  }
}

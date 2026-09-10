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
        void this.stop(rule).then(() => {
          rule.status = 'stopped'
          this.emit()
        })
        changed = true
      }
    }
    if (changed) this.emit()
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

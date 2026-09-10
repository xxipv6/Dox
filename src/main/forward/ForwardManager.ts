import { randomUUID } from 'node:crypto'
import net from 'node:net'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { ForwardRule, ForwardRuleInput } from '../../shared/types'

interface InternalRule extends ForwardRule {
  /** 本地转发的 TCP server */
  server?: net.Server
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
        void this.stop(rule)
        rule.status = 'stopped'
        changed = true
      }
    }
    if (changed) this.emit()
  }

  /** 本地转发：net.createServer → forwardOut 管道 */
  private startLocal(rule: InternalRule, client: Client): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
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
      server.once('error', reject)
      server.listen(rule.listenPort, rule.listenHost, () => resolve())
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
      await new Promise<void>((resolve) => rule.server!.close(() => resolve()))
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

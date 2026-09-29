import net from 'node:net'
import type { AgentManager, TunnelEventPayload } from '../agent/AgentManager'
import { agentVersionOlder, TUNNEL_MIN_AGENT_VERSION } from '../../shared/agentVersion'
import type { ForwardRule } from '../../shared/types'

/** 隧道规则的目标面：agent 目标（会话+容器）+ 要拨的地址 */
interface TunnelTarget {
  sessionId: string
  containerName: string
  targetHost: string
  targetPort: number
}

/**
 * 容器端口转发（容器标签的 -L / -R），数据面是容器助手的隧道帧：
 *
 *   -R（容器内监听）：容器里的连接 → agent 监听 → 事件帧 → **本机**拨目标。
 *     「容器里访问 127.0.0.1:5037 = 用上局域网的 adb」就是这条。
 *   -L（本机监听）：本机起 net.Server，每条连接 → tunnel_connect 让 agent
 *     在**容器内**拨目标（容器当出口节点：容器里的 VPN/内网才够得到的地址）。
 *
 * 背压两个方向都是「堵到 TCP 缓冲为止」：
 *   容器→本机：agent 同步写 serve 通道，本机读得慢 agent 自然停读
 *   本机→容器：agent 侧每连接有界队列（溢出断流，见 agent/tunnel.go）
 * 本机侧 socket 写入不设队列上限，writableLength 爆表时断流兜底。
 */
export class ContainerTunnelManager {
  /** connKey = `${ruleId}:${connId}` → 本机侧 socket（-R 是本机拨出去的，-L 是被连进来的） */
  private sockets = new Map<string, net.Socket>()
  /** ruleId → 隧道目标（会话 + 容器 + 拨号地址） */
  private targets = new Map<string, TunnelTarget>()
  /** agent 目标 key（sessionId::container）→ 该目标下的规则 id 集合 */
  private byAgentKey = new Map<string, Set<string>>()
  /** 容器 -L 的本机监听（-R 的监听在容器里，不在这张表） */
  private servers = new Map<string, net.Server>()
  /** -L 模式下应用侧分配 connId（agent 侧只认规则 id + connId 对） */
  private nextConn = 0

  constructor(private readonly agent: AgentManager) {}

  private agentKey(sessionId: string, containerName: string): string {
    return `${sessionId}::${containerName}`
  }

  /** 规则建立：校验容器助手版本 → 注册回调与意图 → 远端开监听 */
  async start(rule: ForwardRule): Promise<void> {
    if (!rule.container) throw new Error('容器转发缺少容器名')
    const st = await this.agent.status(rule.sessionId, rule.container)
    if (!st.installed || !st.version) {
      throw new Error('容器里没有助手：侧栏「远程助手」先「安装到容器」')
    }
    if (agentVersionOlder(st.version, TUNNEL_MIN_AGENT_VERSION)) {
      throw new Error(`容器助手 v${st.version} 过旧，转发需要 v${TUNNEL_MIN_AGENT_VERSION}（升级后再试）`)
    }

    const target: TunnelTarget = {
      sessionId: rule.sessionId,
      containerName: rule.container,
      targetHost: rule.targetHost,
      targetPort: rule.targetPort
    }
    const akey = this.agentKey(target.sessionId, target.containerName)

    this.agent.setTunnelHandler(target.sessionId, target.containerName, (ev) =>
      this.onTunnelEvent(akey, ev)
    )
    this.targets.set(rule.id, target)
    let set = this.byAgentKey.get(akey)
    if (!set) {
      set = new Set()
      this.byAgentKey.set(akey, set)
    }
    set.add(rule.id)
    // 意图先于调用登记：隧道存在期间 serve 通道不被 watch 归零收掉
    // （断线重连的规则重建归 ForwardManager.restartBySession，不走意图）
    this.agent.addTunnelIntent(target.sessionId, target.containerName, rule.id, `${rule.listenHost}:${rule.listenPort}`)

    if (rule.type === 'local') {
      // 容器 -L：本机监听，每条连接让 agent 在容器内拨目标
      await this.startLocalServer(rule, target)
      return
    }

    // 容器 -R：容器内监听（幂等口径：先关同名隧道再开，重开/残留一律清掉）
    await this.agent
      .call(target.sessionId, target.containerName, 'tunnel_close', { id: rule.id })
      .catch(() => undefined)
    await this.agent.call(target.sessionId, target.containerName, 'tunnel_start', {
      id: rule.id,
      listen_addr: `${rule.listenHost}:${rule.listenPort}`
    })
  }

  /** 容器 -L 的本机侧：net.Server + 每条连接一次 tunnel_connect */
  private async startLocalServer(rule: ForwardRule, target: TunnelTarget): Promise<void> {
    const server = net.createServer((socket) => this.onLocalConn(rule, target, socket))
    await new Promise<void>((resolve, reject) => {
      let listening = false
      server.on('error', (err: Error) => {
        if (!listening) reject(err)
        else console.warn(`[tunnel] 容器转发本机监听 ${rule.listenHost}:${rule.listenPort} 错误: ${err.message}`)
      })
      server.listen(rule.listenPort, rule.listenHost, () => {
        listening = true
        resolve()
      })
    })
    this.servers.set(rule.id, server)
  }

  private onLocalConn(rule: ForwardRule, target: TunnelTarget, socket: net.Socket): void {
    this.nextConn++
    const connId = this.nextConn
    const connKey = `${rule.id}:${connId}`
    this.sockets.set(connKey, socket)
    socket.on('data', (chunk) => {
      void this.agent
        .call(target.sessionId, target.containerName, 'tunnel_data', {
          id: rule.id,
          conn: connId,
          data: chunk.toString('base64')
        })
        .catch(() => undefined)
    })
    const bye = (): void => {
      if (!this.sockets.delete(connKey)) return
      socket.destroy()
      void this.agent
        .call(target.sessionId, target.containerName, 'tunnel_close', { id: rule.id, conn: connId })
        .catch(() => undefined)
    }
    socket.on('close', bye)
    socket.on('error', bye)
    // 发起容器内拨号（异步：成败由 open/close 帧回来，close 帧会在 onTunnelEvent 里收掉 socket）
    void this.agent
      .call(target.sessionId, target.containerName, 'tunnel_connect', {
        id: rule.id,
        conn: connId,
        target_addr: `${target.targetHost}:${target.targetPort}`
      })
      .catch(bye)
  }

  /** 规则移除：关远端监听 + 断本机 socket + 摘意图（最后一个摘掉时连回调一起收） */
  async stop(rule: ForwardRule): Promise<void> {
    const target = this.targets.get(rule.id)
    this.targets.delete(rule.id)
    if (!target) return
    const akey = this.agentKey(target.sessionId, target.containerName)
    this.byAgentKey.get(akey)?.delete(rule.id)
    if (this.byAgentKey.get(akey)?.size === 0) {
      this.byAgentKey.delete(akey)
      this.agent.setTunnelHandler(target.sessionId, target.containerName, null)
    }
    this.agent.removeTunnelIntent(target.sessionId, target.containerName, rule.id)
    await this.agent
      .call(target.sessionId, target.containerName, 'tunnel_close', { id: rule.id })
      .catch(() => undefined)
    // 容器 -L 的本机监听：先停接受新连接，再断存量
    const server = this.servers.get(rule.id)
    if (server) {
      this.servers.delete(rule.id)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        setTimeout(resolve, 1000).unref?.()
      })
    }
    this.destroyRuleSockets(rule.id)
  }

  private destroyRuleSockets(ruleId: string): void {
    for (const [key, sock] of [...this.sockets]) {
      if (key.startsWith(`${ruleId}:`)) {
        sock.destroy()
        this.sockets.delete(key)
      }
    }
  }

  private onTunnelEvent(akey: string, ev: TunnelEventPayload | { closed: true }): void {
    if ('closed' in ev) {
      // 通道死了：这个目标下的本机 socket 全断（规则生命周期归 ForwardManager：
      // 断连走 stopBySession、重连走 restartBySession，这里只管数据面收口）
      const ruleIds = this.byAgentKey.get(akey)
      if (!ruleIds) return
      for (const ruleId of ruleIds) this.destroyRuleSockets(ruleId)
      return
    }

    const target = this.targets.get(ev.id)
    if (!target) return
    const connKey = `${ev.id}:${ev.conn}`

    if (ev.op === 'open') {
      // -L 模式的 open 帧是容器内拨号成功的确认：socket 早已在表里，不用动
      if (this.sockets.has(connKey)) return
      // -R 模式：容器里来了新连接 → 本机拨目标
      const sock = net.connect(target.targetPort, target.targetHost)
      this.sockets.set(connKey, sock)
      sock.on('data', (chunk) => {
        // fire-and-forget：顺序由 serve 通道单写点保证；通道死了数据帧本就该丢
        void this.agent
          .call(target.sessionId, target.containerName, 'tunnel_data', {
            id: ev.id,
            conn: ev.conn,
            data: chunk.toString('base64')
          })
          .catch(() => undefined)
      })
      const bye = (): void => {
        if (!this.sockets.delete(connKey)) return // 已收口过
        void this.agent
          .call(target.sessionId, target.containerName, 'tunnel_close', { id: ev.id, conn: ev.conn })
          .catch(() => undefined)
      }
      sock.on('close', bye)
      sock.on('error', bye) // 目标拨不通（adb 没开/地址不通）→ 容器侧这条连接也没了
      return
    }

    if (ev.op === 'data') {
      const sock = this.sockets.get(connKey)
      if (!sock || !ev.data) return
      // 本机侧应用不读了（writableLength 爆表）→ 断流兜底，不无限积内存
      if (sock.writableLength > 16 * 1024 * 1024) {
        sock.destroy()
        this.sockets.delete(connKey)
        return
      }
      sock.write(Buffer.from(ev.data, 'base64'))
      return
    }

    if (ev.op === 'close') {
      const sock = this.sockets.get(connKey)
      if (sock) {
        this.sockets.delete(connKey)
        // 不能 destroy：拨号在途（pending）时 destroy 会把已缓冲的写整个丢掉 ——
        // 容器侧「一接一发即关」的短连接（printf|nc、健康检查）open→data→close
        // 三帧几乎同时到，data 帧的 sock.write 还缓冲在 connect 队列里，
        // destroy 一调数据全灭。end() 等 connect 完成后把缓冲冲刷出去再 FIN；
        // 对端迟迟不关由兜底 destroy 收口。
        sock.end()
        setTimeout(() => sock.destroy(), 10_000).unref?.()
      }
    }
  }
}

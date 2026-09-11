import net from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * SOCKS5（RFC 1928）服务端握手：仅 CONNECT、免认证。
 *
 * 每个入站连接解析出目标地址后交给注入的 connectFn 建立上游流，
 * 随后双向对接。connectFn 由 ForwardManager 用 ssh2 的 forwardOut 提供
 * （经 SSH 通道转发，效果等同 ssh -D）——本文件不 import ssh2，
 * 所以握手解析可以拿假的 connectFn 直接单测。
 */

const REP = {
  OK: 0x00,
  REFUSED: 0x05,
  CMD_NOT_SUPPORTED: 0x07,
  ATYP_NOT_SUPPORTED: 0x08
} as const

export type SocksConnectFn = (
  host: string,
  port: number,
  onReady: (err: Error | null, stream?: Duplex) => void
) => void

function reply(rep: number): Buffer {
  // bnd 地址段填零即可：RFC 允许，客户端也不该依赖它
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

export function handleSocks5(socket: net.Socket, connectFn: SocksConnectFn): void {
  let buf = Buffer.alloc(0)
  let stage: 'greeting' | 'request' | 'pipe' = 'greeting'

  const fail = (rep: number): void => {
    socket.end(reply(rep))
  }

  socket.on('data', (chunk: Buffer) => {
    // 管道阶段数据由 pipe 接管，handler 不应再收到；收到直接丢弃防御
    if (stage === 'pipe') return
    buf = Buffer.concat([buf, chunk])

    if (stage === 'greeting') {
      if (buf.length < 2) return
      const nmethods = buf[1]
      if (buf.length < 2 + nmethods) return
      if (buf[0] !== 0x05) {
        socket.destroy()
        return
      }
      socket.write(Buffer.from([0x05, 0x00]))
      buf = buf.subarray(2 + nmethods)
      stage = 'request'
    }

    if (stage === 'request') {
      if (buf.length < 4) return
      const [ver, cmd, , atyp] = buf
      if (ver !== 0x05) {
        socket.destroy()
        return
      }
      if (cmd !== 0x01) return fail(REP.CMD_NOT_SUPPORTED)

      let host: string
      let off: number
      if (atyp === 0x01) {
        // IPv4
        if (buf.length < 4 + 4 + 2) return
        host = [...buf.subarray(4, 8)].join('.')
        off = 8
      } else if (atyp === 0x03) {
        // 域名：远端解析（本机连不上的内网名正是代理的意义）
        const len = buf[4]
        if (buf.length < 4 + 1 + len + 2) return
        host = buf.subarray(5, 5 + len).toString('utf8')
        off = 5 + len
      } else if (atyp === 0x04) {
        // IPv6
        if (buf.length < 4 + 16 + 2) return
        const b = buf.subarray(4, 20)
        const groups: string[] = []
        for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16))
        host = groups.join(':')
        off = 20
      } else {
        return fail(REP.ATYP_NOT_SUPPORTED)
      }

      const port = buf.readUInt16BE(off)
      // 客户端可能把首包数据跟在请求后面一起塞过来（流水线）：pipe 之前先补写
      const early = buf.subarray(off + 2)
      buf = Buffer.alloc(0)
      stage = 'pipe'
      socket.pause()

      connectFn(host, port, (err, stream) => {
        if (err || !stream) return fail(REP.REFUSED)
        socket.write(reply(REP.OK), () => {
          if (early.length) stream.write(early)
          socket.resume()
          socket.pipe(stream).pipe(socket)
          socket.on('error', () => stream.destroy())
          stream.on('error', () => socket.destroy())
        })
      })
    }
  })

  // 客户端 RST / 半开都正常，没这个监听者 Node 会把 error 抛穿主进程
  socket.on('error', () => undefined)
}

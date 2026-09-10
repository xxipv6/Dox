import { Sentry, type ZDetection, type ZSession } from 'zmodem.js'

/**
 * ZMODEM 桥接：拦截终端数据流，识别 rz/sz 发起序列并接管会话。
 * - 远端执行 sz（发送）→ 弹目录选择框，接收文件逐块落盘到所选目录
 * - 远端执行 rz（接收）→ 弹文件选择框，主进程读入后经 ZMODEM 发送
 * 会话期间用户键盘输入被 TerminalPanel 屏蔽，避免污染协议流。
 */

export interface ZmodemBridge {
  consume(chunk: Uint8Array | ArrayBuffer | string): void
  isActive(): boolean
}

const encoder = new TextEncoder()

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function createZmodemBridge(
  sessionId: string,
  writeToTerm: (data: Uint8Array) => void
): ZmodemBridge {
  let active = false

  const print = (msg: string): void =>
    writeToTerm(encoder.encode(`\r\n\x1b[36m[zmodem]\x1b[0m ${msg}\r\n`))

  /** Sentry 只接受字节序列，字符串会被静默转成空数组并吞掉输出，这里做兜底 */
  const toBytes = (chunk: Uint8Array | ArrayBuffer | string): Uint8Array => {
    if (typeof chunk === 'string') return encoder.encode(chunk)
    return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  }

  /** 远端 sz → 本机接收 */
  async function handleReceive(zsession: ZSession): Promise<void> {
    print('检测到 sz：远端正在发送文件')
    const dir = await window.api.pickDirectory('选择文件保存目录')

    zsession.on('offer', (offer) => {
      const details = offer.get_details()
      if (!dir) {
        offer.skip()
        print(`已跳过 ${details.name}（未选择保存目录）`)
        return
      }
      const chunks: Uint8Array[] = []
      let received = 0
      offer
        .accept({
          on_input: (payload) => {
            chunks.push(payload)
            received += payload.length
          }
        })
        .then(async () => {
          const data = concat(chunks, received)
          const saved = await window.api.writeReceivedFile(dir, details.name, data)
          print(`已接收 ${details.name}（${received} 字节）→ ${saved}`)
        })
        .catch((err: unknown) => print(`接收 ${details.name} 失败：${String(err)}`))
    })

    try {
      await zsession.start()
    } catch (err) {
      print(`会话启动失败：${String(err)}`)
    }
  }

  /** 远端 rz → 本机发送 */
  async function handleSend(zsession: ZSession): Promise<void> {
    print('检测到 rz：远端等待接收文件')
    const files = await window.api.pickAndReadFiles()
    if (!files.length) {
      print('未选择文件，结束会话')
      try {
        await zsession.close()
      } catch {
        /* 会话可能已结束 */
      }
      return
    }

    const totalRemaining = (from: number): number =>
      files.slice(from).reduce((sum, f) => sum + f.size, 0)

    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      try {
        const xfer = await zsession.send_offer({
          name: f.name,
          size: f.size,
          mtime: Math.floor(Date.now() / 1000),
          files_remaining: files.length - i,
          bytes_remaining: totalRemaining(i)
        })
        if (!xfer) {
          print(`${f.name} 被远端跳过`)
          continue
        }
        await xfer.end(f.data)
        print(`已发送 ${f.name}（${f.size} 字节）`)
      } catch (err) {
        print(`发送 ${f.name} 失败：${String(err)}`)
        break
      }
    }

    try {
      await zsession.close()
    } catch {
      /* 忽略关闭时的协议异常 */
    }
  }

  const sentry = new Sentry({
    to_terminal: (octets) => writeToTerm(new Uint8Array(octets)),
    sender: (octets) => window.api.input(sessionId, new Uint8Array(octets)),
    on_detect: (detection: ZDetection) => {
      const zsession = detection.confirm()
      active = true
      zsession.on('session_end', () => {
        active = false
        print('会话结束，终端恢复交互')
      })
      if (zsession.type === 'receive') void handleReceive(zsession)
      else void handleSend(zsession)
    },
    on_retract: () => {
      active = false
    }
  })

  return {
    consume: (chunk) => sentry.consume(toBytes(chunk)),
    isActive: () => active
  }
}

import { Sentry, type ZDetection, type ZSession } from 'zmodem.js'

/**
 * ZMODEM 桥接：拦截终端数据流，识别 rz/sz 发起序列并接管会话。
 * - 远端执行 sz（发送）→ 弹目录选择框，接收文件逐块落盘到所选目录
 * - 远端执行 rz（接收）→ 弹文件选择框，主进程读入后经 ZMODEM 发送
 * 会话期间用户键盘输入被 TerminalPanel 屏蔽，避免污染协议流。
 *
 * 关键约束：**任何异常都必须让 active 归位**。否则输入屏蔽会一直生效，
 * 终端表现为彻底假死（无报错、无超时、无逃生口），只能关标签页。
 */

export interface ZmodemBridge {
  consume(chunk: Uint8Array | ArrayBuffer | string): void
  isActive(): boolean
  /** 用户主动中断（Esc / Ctrl+C）：中止协议会话并恢复终端交互 */
  abort(): void
}

const encoder = new TextEncoder()
/** 无进展看门狗：接管后超过该时长仍无任何协议进展则自动中止 */
const WATCHDOG_MS = 60_000

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
  let session: ZSession | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const print = (msg: string, color = '36'): void =>
    writeToTerm(encoder.encode(`\r\n\x1b[${color}m[zmodem]\x1b[0m ${msg}\r\n`))

  /** Sentry 只接受字节序列，字符串会被静默转成空数组并吞掉输出，这里做兜底 */
  const toBytes = (chunk: Uint8Array | ArrayBuffer | string): Uint8Array => {
    if (typeof chunk === 'string') return encoder.encode(chunk)
    return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  }

  /** 统一的会话收尾：无论正常结束还是异常，都必须恢复终端交互 */
  function finish(reason?: string): void {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    if (session && !session.aborted()) {
      try {
        session.abort()
      } catch {
        /* 会话可能已结束 */
      }
    }
    session = null
    if (active) {
      active = false
      print(reason ? `会话已中止（${reason}），终端恢复交互` : '会话结束，终端恢复交互')
    }
  }

  function armWatchdog(): void {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      print('等待对端响应超时，自动中止', '33')
      finish('超时')
    }, WATCHDOG_MS)
  }

  /** 远端 sz → 本机接收 */
  async function handleReceive(zsession: ZSession): Promise<void> {
    print('检测到 sz：远端正在发送文件')
    const dir = await window.api.pickDirectory('选择文件保存目录')
    if (!dir) {
      print('未选择保存目录，已跳过全部文件', '33')
    }

    zsession.on('offer', (offer) => {
      const details = offer.get_details()
      if (!dir) {
        offer.skip()
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
        .catch((err: unknown) => print(`接收 ${details.name} 失败：${String(err)}`, '31'))
    })

    await zsession.start()
  }

  /** 远端 rz → 本机发送 */
  async function handleSend(zsession: ZSession): Promise<void> {
    print('检测到 rz：远端等待接收文件')
    const files = await window.api.pickAndReadFiles()
    if (!files.length) {
      print('未选择文件，结束会话', '33')
      return
    }

    const totalRemaining = (from: number): number =>
      files.slice(from).reduce((sum, f) => sum + f.size, 0)

    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const xfer = await zsession.send_offer({
        name: f.name,
        size: f.size,
        mtime: Math.floor(Date.now() / 1000),
        files_remaining: files.length - i,
        bytes_remaining: totalRemaining(i)
      })
      if (!xfer) {
        print(`${f.name} 被远端跳过`, '33')
        continue
      }
      await xfer.end(f.data)
      print(`已发送 ${f.name}（${f.size} 字节）`)
    }
  }

  const sentry = new Sentry({
    to_terminal: (octets) => writeToTerm(new Uint8Array(octets)),
    sender: (octets) => window.api.input(sessionId, new Uint8Array(octets)),
    on_detect: (detection: ZDetection) => {
      const zsession = detection.confirm()
      session = zsession
      active = true
      armWatchdog()
      zsession.on('session_end', () => finish())
      // 每个协议事件都重置看门狗：有进展就不算超时
      zsession.on('offer', () => armWatchdog())

      const run = zsession.type === 'receive' ? handleReceive : handleSend
      // 关键：pick* 的 reject（例如文件超过 256MB、IPC 异常）若逃逸出去会变成
      // 未处理 rejection，且 active 永远为 true → 键盘永久失效
      run(zsession)
        .then(() => {
          // 正常收尾由 send/close 触发；这里兜一次，避免对端不回 ZFIN 时卡住
          try {
            zsession.close()
          } catch {
            finish()
          }
        })
        .catch((err: unknown) => {
          print(`错误：${err instanceof Error ? err.message : String(err)}`, '31')
          finish('出错')
        })
    },
    on_retract: () => {
      active = false
      session = null
    }
  })

  return {
    consume: (chunk) => sentry.consume(toBytes(chunk)),
    isActive: () => active,
    abort: () => finish('用户中断')
  }
}

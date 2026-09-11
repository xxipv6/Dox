/**
 * 一键 SOCKS5 代理（ssh -D 等价）的全套验证：
 *
 *  阶段 1（单测，无需参数）：
 *    socks.ts 握手状态机 —— 用**假 connectFn** 驱动真实 net.Socket 客户端：
 *    域名/IPv4 请求解析、流水线首包补写、echo 管道、不支持指令回 0x07、
 *    上游失败回非 0
 *  阶段 2（端到端）：
 *    UI 建「代理 -D」规则 → 经代理 SOCKS5 CONNECT 远端 nc 监听（通）
 *    → CONNECT 一个死端口（败）→ 清理
 *
 * 用法：node scripts/verify-socks.mjs            # 只跑阶段 1
 *      node scripts/verify-socks.mjs <host> [port] [user] [password]
 * 前置（阶段 2）：npm run build；远端需要 nc（busybox 自带）。
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import { mkdirSync } from 'node:fs'
import { handleSocks5 } from '../src/main/forward/socks.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

/** 发一次 SOCKS5 握手，返回 { rep, socket, host, port }（socket 已就绪可读写） */
function socksConnect(proxyPort, atypBytes, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect(proxyPort, '127.0.0.1')
    let stage = 'greeting'
    const chunks = []
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ rep: -1 })
    }, timeoutMs)
    socket.on('data', (d) => {
      if (stage === 'greeting') {
        if (d[0] !== 0x05) {
          clearTimeout(timer)
          resolve({ rep: -2 })
          return
        }
        stage = 'request'
        socket.write(atypBytes)
        return
      }
      if (stage === 'request') {
        clearTimeout(timer)
        const rep = d[1]
        if (rep === 0) {
          resolve({ rep, socket })
        } else {
          resolve({ rep })
          socket.destroy()
        }
        stage = 'done'
        return
      }
      chunks.push(d)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve({ rep: -3 })
    })
    // greeting: VER NMETHODS METHODS
    socket.write(Buffer.from([0x05, 0x01, 0x00]))
  })
}

const domainReq = (host, port) =>
  Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    Buffer.from(host),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b })()
  ])
const ipv4Req = (ip, port) =>
  Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x01, ...ip.split('.').map(Number)]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b })()
  ])

// ---------- 阶段 1：握手状态机单测 ----------
console.log('阶段 1：socks.ts 握手单测（假 connectFn）')

{
  // echo 上游：捕获目标地址，数据原样弹回
  let seen = null
  const server = net.createServer((socket) =>
    handleSocks5(socket, (host, port, cb) => {
      seen = { host, port }
      const echo = new PassThrough()
      cb(null, echo)
    })
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // 域名请求 + echo
  {
    const { rep, socket } = await socksConnect(port, domainReq('example.com', 443))
    check('域名 CONNECT 成功', rep === 0, `rep=${rep}`)
    check('目标地址解析正确', seen?.host === 'example.com' && seen?.port === 443, JSON.stringify(seen))
    if (socket) {
      const echoed = await new Promise((res) => {
        socket.once('data', (d) => res(d.toString()))
        socket.write('ping-123')
      })
      check('管道数据贯通（echo）', echoed === 'ping-123', String(echoed))
      socket.destroy()
    }
  }
  // IPv4 请求
  {
    const { rep, socket } = await socksConnect(port, ipv4Req('10.1.2.3', 8080))
    check('IPv4 CONNECT 成功', rep === 0, `rep=${rep}`)
    check('IPv4 地址解析正确', seen?.host === '10.1.2.3' && seen?.port === 8080, JSON.stringify(seen))
    socket?.destroy()
  }
  // BIND 指令 → 0x07
  {
    const { rep } = await socksConnect(port, Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    check('BIND 回 0x07 不支持', rep === 7, `rep=${rep}`)
  }
  server.close()
}

{
  // 失败上游：CONNECT 应回非 0
  const server = net.createServer((socket) =>
    handleSocks5(socket, (_h, _p, cb) => cb(new Error('connect refused')))
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const { rep } = await socksConnect(port, domainReq('dead.host', 9))
  check('上游失败回非 0', rep !== 0 && rep > 0, `rep=${rep}`)
  server.close()
}

// ---------- 阶段 2：端到端 ----------
const host = process.argv[2]
if (!host) {
  console.log('\n（未给主机参数，跳过阶段 2 端到端）')
  process.exit(failed ? 1 : 0)
}
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''
mkdirSync('shots', { recursive: true })
const SOCKS_PORT = 11080
const ALIVE_PORT = 8324

console.log('阶段 2：端到端（UI 建规则 → 经代理连通/拒连）')

const ssh = new Client()
await new Promise((res, rej) => {
  ssh.on('ready', res).on('error', rej).connect({ host, port, username: user, password, readyTimeout: 10000 })
})
const remoteExec = (c) =>
  new Promise((res, rej) => {
    ssh.exec(c, (e, s) => {
      if (e) return rej(e)
      let o = ''
      s.on('data', (d) => (o += d))
      s.stderr.on('data', () => {})
      s.on('close', (code) => (code === 0 ? res(o) : rej(new Error(`${c} -> ${code}`))))
    })
  })
await remoteExec('pkill -f "nc -lk" 2>/dev/null; true').catch(() => {})
ssh.exec(`nc -lk -p ${ALIVE_PORT}`, () => {})
await new Promise((r) => setTimeout(r, 800))
await remoteExec(`nc -z 127.0.0.1 ${ALIVE_PORT}`)
check('远端 nc 监听就绪', true)

const cleanup = async () => {
  try { await remoteExec('pkill -f "nc -lk" || true') } catch {}
  ssh.end()
}

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2000)

await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input.port').fill(String(port))
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill(password)
await win.locator('button:has-text("仅连接")').click()
for (let i = 0; i < 8; i++) {
  await win.waitForTimeout(1000)
  const hk = await win.evaluate(() =>
    [...document.querySelectorAll('.dialog-header')].map((e) => e.textContent.trim()).some((t) => t.includes('主机'))
  )
  if (hk) {
    await win.locator('button:has-text("信任并保存")').click()
    break
  }
}
await win.locator('.terminal-container:visible').first().click()
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

// 展开「端口转发」分区 → + → 代理 -D → 填端口 → 启动
const sectionHead = win.locator('.sidebar .section-head', { hasText: '端口转发' })
await sectionHead.waitFor({ timeout: 10000 })
if ((await sectionHead.getAttribute('aria-expanded')) === 'false') {
  await sectionHead.click()
  await win.waitForTimeout(600)
}
await win.locator('button[title="添加转发"]').click()
await win.waitForTimeout(400)
await win.locator('.type-switch label', { hasText: '代理 -D' }).click()
await win.locator('input[placeholder="监听端口"]').fill(String(SOCKS_PORT))
await win.locator('button:has-text("启动转发")').click()
await win.waitForTimeout(1500)
await win.screenshot({ path: 'shots/63-socks-rule.png' })

const rules = await win.evaluate(() => window.api.listForwards())
const rule = rules.find((r) => r.type === 'socks' && r.listenPort === SOCKS_PORT)
check('SOCKS5 规则 active', rule?.status === 'active', JSON.stringify(rules))

// 经代理 CONNECT 远端 nc（活的）→ rep 0
const alive = await socksConnect(SOCKS_PORT, ipv4Req('127.0.0.1', ALIVE_PORT), 8000)
check('经代理 CONNECT 活端口成功（流量真的走了远端出口）', alive.rep === 0, `rep=${alive.rep}`)
alive.socket?.destroy()

// 经代理 CONNECT 死端口 → rep 非 0
const dead = await socksConnect(SOCKS_PORT, ipv4Req('127.0.0.1', 9), 8000)
check('经代理 CONNECT 死端口被拒（证明确实到了远端再连）', dead.rep !== 0 && dead.rep > 0, `rep=${dead.rep}`)

// ---- 清理 ----
if (rule) await win.evaluate((id) => window.api.removeForward(id), rule.id)
await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

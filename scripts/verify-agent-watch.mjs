/**
 * 转发建议接入 agent watch_ports 的集成验证：
 *  脚本直连预装 agent（跳过 UI 安装，verify-agent 已覆盖那条路）→
 *  应用连接（TerminalPanel 自动走 agent 长连接）→ 静默起 nc（无横幅）→
 *  气泡应在 ~4s 内出现（agent 3s 推送；/proc 轮询要 ~10s，时序即路径证明）→
 *  转发 → 本机连通 → 清理（还原未安装状态）
 *
 * 用法：node scripts/verify-agent-watch.mjs <host> [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import net from 'node:net'
import { createReadStream } from 'node:fs'
import { mkdirSync } from 'node:fs'

/** 本机 TCP 连通性检查（跨平台：Windows 没有 nc -z，用 net.connect 等价实现） */
function tcpReachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 3000 })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

const host = process.argv[2]
if (!host) {
  console.error('用法: node scripts/verify-agent-watch.mjs <host> [port] [user] [password]')
  process.exit(2)
}
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''
mkdirSync('shots', { recursive: true })
const FRESH_PORT = 8328

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

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

// ---- 预装 agent（按远端架构挑二进制）----
const machine = (await remoteExec('uname -m')).trim()
const goarch = machine === 'x86_64' ? 'amd64' : 'arm64'
await remoteExec('rm -rf ~/.dox && mkdir -p ~/.dox')
await new Promise((res, rej) => {
  ssh.sftp((err, sftp) => {
    if (err) return rej(err)
    const src = createReadStream(`build/agent/dox-agent-linux-${goarch}`)
    const dst = sftp.createWriteStream(`${''}/root/.dox/dox-agent`)
    src.on('error', rej)
    dst.on('error', rej)
    dst.on('close', res)
    src.pipe(dst)
  })
}).catch(async () => {
  // HOME 不一定是 /root：走 sh 解析
  const home = (await remoteExec('echo $HOME')).trim()
  await new Promise((res, rej) => {
    ssh.sftp((err, sftp) => {
      if (err) return rej(err)
      const src = createReadStream(`build/agent/dox-agent-linux-${goarch}`)
      const dst = sftp.createWriteStream(`${home}/.dox/dox-agent`)
      src.on('error', rej)
      dst.on('error', rej)
      dst.on('close', res)
      src.pipe(dst)
    })
  })
})
await remoteExec('chmod 755 ~/.dox/dox-agent && ~/.dox/dox-agent version')
check('agent 预装完成', true)

const cleanup = async () => {
  try { await remoteExec('pkill -f "nc -lk" 2>/dev/null; rm -rf ~/.dox; true') } catch {}
  ssh.end()
}

// ---- 应用侧：连接（TerminalPanel 自动走 agent 推送）----
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

// 事件埋点：等 agent watch 首帧（基线）到达再动夹具 —— 否则 nc 会被首帧收进基线，永远不弹
await win.evaluate(() => {
  window.__agentEvents = []
  window.api.onAgentPorts((sid, ctr, data) => window.__agentEvents.push(JSON.stringify(data)))
})

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
{
  const deadline = Date.now() + 12000
  let frames = 0
  while (Date.now() < deadline && frames === 0) {
    frames = await win.evaluate(() => window.__agentEvents.length)
    if (frames === 0) await win.waitForTimeout(300)
  }
  check('agent watch 首帧（基线）已到达', frames > 0)
}
await win.keyboard.press('Escape')

// 静默起 nc（无横幅），agent 3s 推送应在 ~8s 内出气泡
const t0 = Date.now()
ssh.exec(`nc -lk -p ${FRESH_PORT}`, () => {})
const toast = win.locator('.port-toast').filter({ hasText: String(FRESH_PORT) }).first()
let latencyMs = -1
try {
  await toast.waitFor({ timeout: 8000 })
  latencyMs = Date.now() - t0
} catch { /* 未出现 */ }
check(
  '静默监听被 agent 推送发现（<8s，/proc 轮询要 ~10s）',
  latencyMs >= 0,
  `latency=${latencyMs}`
)
if (latencyMs >= 0) console.log(`  气泡延迟 ${(latencyMs / 1000).toFixed(1)}s`)
await win.screenshot({ path: 'shots/65-agent-watch-toast.png' })

// 转发 → 本机连通
await toast.locator('button.act', { hasText: '转发到本机' }).click()
await win.waitForTimeout(3000)
const rules = await win.evaluate(() => window.api.listForwards())
const rule = rules.find((r) => r.targetPort === FRESH_PORT && r.status === 'active')
check('转发规则 active', !!rule, JSON.stringify(rules))
let reachable = false
if (rule) {
  for (let i = 0; i < 5; i++) {
    if (await tcpReachable(rule.listenPort)) {
      reachable = true
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}
check('本机经转发连通', reachable)

// ---- 清理 ----
if (rule) await win.evaluate((id) => window.api.removeForward(id), rule.id)
await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

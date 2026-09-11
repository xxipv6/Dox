/**
 * agent serve 通道断线自动重建的端到端验证：
 *  预装 agent → 应用连接（agent 推送生效中，先推一个端口证明）→
 *  杀掉应用的 sshd 会话进程（只杀 pty 会话，脚本自己的 notty 连接不受影响）→
 *  应用自动重连 → AgentManager 按订阅意图重建 serve 通道 →
 *  再静默起一个 nc：气泡应仍在 <8s 出现（agent 推送；若掉回 /proc 轮询要 ~10s）→
 *  清理。
 *
 * 用法：node scripts/verify-agent-keepalive.mjs [host] [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { createReadStream } from 'node:fs'
import { mkdirSync } from 'node:fs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
mkdirSync('shots', { recursive: true })
const PORT_A = 8361
const PORT_B = 8362

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
await remoteExec('chmod 755 ~/.dox/dox-agent && ~/.dox/dox-agent version')
await remoteExec(`pkill -f "nc -lk" 2>/dev/null; true`).catch(() => {})
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

// 事件埋点：失败时能说清是主进程没发还是组件没弹
await win.evaluate(() => {
  window.__agentEvents = []
  window.api.onAgentPorts((sid, data) =>
    window.__agentEvents.push([Math.round(performance.now() / 1000), JSON.stringify(data)])
  )
})
const dumpEvents = () =>
  win.evaluate(() => window.__agentEvents).then((ev) => console.log('  agent 事件流:', JSON.stringify(ev)))

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
// 等 agent watch 的首帧（基线）到达再动夹具 —— 否则 nc 会被首帧收进基线，永远不弹（实测踩过）
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

// ---- 阶段 1：agent 推送生效中（基线外的静默 nc 应推上来）----
// 宽限 15s：nc 经 exec 通道绑定可能错过 1-2 个扫描周期（每周期 3s），
// 本阶段只证「agent → 气泡」端到端通路；路径甄别（agent vs /proc）是阶段 3 的事
ssh.exec(`nc -lk -p ${PORT_A}`, () => {})
const toastA = win.locator('.port-toast').filter({ hasText: String(PORT_A) }).first()
let aMs = -1
const t0 = Date.now()
try {
  await toastA.waitFor({ timeout: 15000 })
  aMs = Date.now() - t0
} catch { /* 未出现 */ }
check('阶段1：agent 推送生效（静默 nc 秒推）', aMs >= 0, `latency=${aMs}`)
if (aMs < 0) await dumpEvents()
await toastA.locator('button[title="忽略"], .close, button:has-text("×")').first().click().catch(() => {})

// ---- 阶段 2：杀掉应用的 sshd 会话（只杀 pty 会话；脚本的 notty 连接免疫）----
await remoteExec(`pkill -f "sshd: ${user}@pts" 2>/dev/null; true`).catch(() => {})
console.log('  已杀应用的 SSH 会话，等待自动重连 + agent 通道重建…')
// 重连（退避 + 建连 + shell + agentStatus + 通道重建）给足时间
await win.waitForTimeout(15000)

// ---- 阶段 3：重连后再静默起 nc，仍应 agent 秒推（掉回 /proc 就要 ~10s）----
const t1 = Date.now()
ssh.exec(`nc -lk -p ${PORT_B}`, () => {})
const toastB = win.locator('.port-toast').filter({ hasText: String(PORT_B) }).first()
let bMs = -1
try {
  await toastB.waitFor({ timeout: 8000 })
  bMs = Date.now() - t1
} catch { /* 未出现 */ }
check('阶段3：重连后 agent 推送自动恢复（<8s）', bMs >= 0, `latency=${bMs}`)
if (bMs < 0) await dumpEvents()
if (bMs >= 0) console.log(`  重连后气泡延迟 ${(bMs / 1000).toFixed(1)}s`)
await win.screenshot({ path: 'shots/67-agent-keepalive.png' })

await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

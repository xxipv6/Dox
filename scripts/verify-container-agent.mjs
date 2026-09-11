/**
 * 容器内 agent（Dev Containers 式注入）的端到端验证：
 *  SSH 连 dind → 进 inner 容器标签 → 助手面板点「安装到容器」→ 已安装 →
 *  容器里静默 nc：气泡 ~3s 出现（agent 推送；轮询要 ~10s，时序即路径证明）→
 *  状态条出现（容器标签也有 CPU/MEM）→
 *  docker restart inner（SSH 全程没断，主进程重连钩子管不到）→
 *  45s 节流重试自动复活 → 再静默 nc 仍秒推 → 清理。
 *
 * 用法：node scripts/verify-container-agent.mjs [host] [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs；dox-sshd-test dind + inner 在跑
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { mkdirSync } from 'node:fs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
mkdirSync('shots', { recursive: true })
const INNER = 'inner'
const PORT_A = 8371
const PORT_B = 8372

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

// 夹具：inner 在跑、无容器内 agent、无残留 nc
await remoteExec(`docker start ${INNER} 2>/dev/null || docker run -d --name ${INNER} alpine sleep 3600`)
await remoteExec(`docker exec ${INNER} sh -c "rm -f /tmp/dox-agent; pkill nc 2>/dev/null; true"`)
console.log('  夹具就绪：inner 运行中，无容器内 agent')

const cleanup = async () => {
  try { await remoteExec(`docker exec ${INNER} sh -c "pkill nc 2>/dev/null; rm -f /tmp/dox-agent; true"`) } catch {}
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

// 事件埋点（容器泳道 ctr='inner'）
await win.evaluate(() => {
  window.__agentEvents = []
  window.api.onAgentPorts((sid, ctr, data) =>
    window.__agentEvents.push([Math.round(performance.now() / 1000), ctr, JSON.stringify(data)])
  )
  window.__statsEvents = []
  window.api.onAgentStats((sid, ctr, data) =>
    window.__statsEvents.push([Math.round(performance.now() / 1000), ctr, JSON.stringify(data).slice(0, 120)])
  )
})

// ---- SSH 连接 → 进容器 ----
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
  if (hk) { await win.locator('button:has-text("信任并保存")').click(); break }
}
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 20000 })
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

const ctrHead = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await ctrHead.getAttribute('aria-expanded')) === 'false') {
  await ctrHead.click()
  await win.waitForTimeout(1500)
}
const row = win.locator('.container').filter({ hasText: INNER }).first()
await row.waitFor({ timeout: 15000 })
await row.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
await win.waitForTimeout(3000)

// ---- 助手面板：安装到容器 ----
const agentHead = win.locator('.sidebar .section-head', { hasText: '助手' })
if ((await agentHead.getAttribute('aria-expanded')) === 'false') {
  await agentHead.click()
  await win.waitForTimeout(1000)
}
const installBtn = win.locator('button', { hasText: `安装到容器 ${INNER}` })
check('面板给出「安装到容器」入口', (await installBtn.count()) > 0)
await installBtn.click()
const installed = win.locator('.sidebar .agent-ok', { hasText: '已安装' })
let installOk = false
try {
  await installed.waitFor({ timeout: 30000 })
  installOk = true
} catch { /* 超时 */ }
check('容器内 agent 安装成功（面板显示已安装）', installOk)

// 装完面板里开的容器标签还活着：切回容器标签触发 watch
// （安装过程中 activeSession 没变，watch 本就挂在容器标签上 —— 等首帧即可）
{
  const deadline = Date.now() + 15000
  let frames = 0
  while (Date.now() < deadline && frames === 0) {
    frames = await win.evaluate(
      (inner) => window.__agentEvents.filter((e) => e[1] === inner).length,
      INNER
    )
    if (frames === 0) await win.waitForTimeout(400)
  }
  check('容器泳道首帧（基线）已到达', frames > 0, JSON.stringify(await win.evaluate(() => window.__agentEvents)))
}

// ---- 阶段 1：容器内静默 nc → agent 秒推（<8s；docker exec 轮询要 ~10s）----
const t0 = Date.now()
ssh.exec(`docker exec -d ${INNER} nc -lk -p ${PORT_A}`, () => {})
const toastA = win.locator('.port-toast').filter({ hasText: String(PORT_A) }).first()
let aMs = -1
try {
  await toastA.waitFor({ timeout: 8000 })
  aMs = Date.now() - t0
} catch { /* 未出现 */ }
check('阶段1：容器内 agent 推送生效（<8s）', aMs >= 0, `latency=${aMs}`)
if (aMs >= 0) console.log(`  气泡延迟 ${(aMs / 1000).toFixed(1)}s`)

// ---- 状态条（容器标签也有）----
// 宽限 30s：装完 agent 的重试链路是 agentStatus→watchPorts→watchStats 一串
// SSH exec，dind 里每条 docker exec 都要几百 ms，实测曾擦着 15s 线出现
const bar = win.locator('.agent-stats:visible')
let barText = ''
try {
  await bar.waitFor({ timeout: 30000 })
  barText = (await bar.textContent()) ?? ''
} catch { /* 未出现 */ }
check('容器标签状态条出现（CPU/MEM）', /CPU \d+%/.test(barText) && /MEM \d+%/.test(barText), barText)
if (!barText) {
  const dump = await win.evaluate(() => ({
    statsEvents: window.__statsEvents,
    barCount: document.querySelectorAll('.agent-stats').length
  }))
  console.log('  stats 事件流:', JSON.stringify(dump.statsEvents), 'bar 节点数:', dump.barCount)
}
await win.screenshot({ path: 'shots/70-container-agent.png' })

// ---- 阶段 2：docker restart → 45s 节流重试自动复活 ----
await remoteExec(`docker restart ${INNER}`)
console.log('  已 restart 容器，等待 agent 自动复活（45s 节流 + 容器起步）…')
await win.waitForTimeout(60_000)
// 复活后再起静默 nc：若 agent 回来了 <8s 出气泡；没回来轮询基线已乱，10s+
const t1 = Date.now()
ssh.exec(`docker exec -d ${INNER} nc -lk -p ${PORT_B}`, () => {})
const toastB = win.locator('.port-toast').filter({ hasText: String(PORT_B) }).first()
let bMs = -1
try {
  await toastB.waitFor({ timeout: 15000 })
  bMs = Date.now() - t1
} catch { /* 未出现 */ }
check('阶段2：容器重启后 agent 自动复活并恢复推送', bMs >= 0, `latency=${bMs}`)
if (bMs >= 0) console.log(`  复活后气泡延迟 ${(bMs / 1000).toFixed(1)}s`)
await win.screenshot({ path: 'shots/71-container-agent-revived.png' })

await cleanup()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

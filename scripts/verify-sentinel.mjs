/**
 * 端口哨兵 + 网络页→进程页跳转的端到端验证：
 *  SSH 连 dind → UI 装宿主助手 → 等端口基线建立 → 静默起 nc 监听 →
 *  ① 哨兵 toast 出现（黄警告，带进程名 nc 与 PID）→
 *  ② 点击 toast → 性能监控网络页打开且按 :8399 过滤 →
 *  ③ 连接行点进程名 → 跳进程页、PID chip 精确过滤、那行就是 nc →
 *  清理（杀 nc、卸助手）。
 *
 * 用法：node scripts/verify-sentinel.mjs [host] [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs；dox-sshd-test 在跑
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'
import { mkdirSync } from 'node:fs'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
const SENTINEL_PORT = 8399
mkdirSync('shots', { recursive: true })

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

// 夹具：宿主机干净（未装助手、没有哨兵端口）
await remoteExec('rm -rf ~/.dox; true').catch(() => {})
await remoteExec(`pkill -f 'nc -lk -p ${SENTINEL_PORT}' 2>/dev/null; true`).catch(() => {})
console.log('  夹具就绪')

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

// ---- SSH 连接 ----
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

// ---- 装宿主助手 ----
const agentHead = win.locator('.sidebar .section-head', { hasText: '助手' })
if ((await agentHead.getAttribute('aria-expanded')) === 'false') {
  await agentHead.click()
  await win.waitForTimeout(800)
}
await win.locator('button:has-text("安装到这台机器")').click()
let installOk = false
try {
  await win.locator('.sidebar .agent-ok', { hasText: '已安装' }).waitFor({ timeout: 30000 })
  installOk = true
} catch { /* 超时 */ }
check('宿主助手安装成功', installOk)

// ---- 等端口基线（watch_ports 首帧 + 余量）----
await win.waitForTimeout(9000)

// ---- 静默起 nc 监听（不走终端，哨兵只能来自 agent 差分）----
await remoteExec(`nohup nc -lk -p ${SENTINEL_PORT} >/dev/null 2>&1 &`)

// ---- ① 哨兵 toast ----
const toast = win.locator('.port-toast.sentinel', { hasText: `:${SENTINEL_PORT}` }).first()
let toastOk = false
try {
  await toast.waitFor({ timeout: 15000 })
  toastOk = true
} catch { /* 未出现 */ }
check('新监听端口弹出哨兵 toast', toastOk)
// 进程名反查是异步的，多等一拍
let toastText = ''
for (let i = 0; i < 8; i++) {
  await win.waitForTimeout(700)
  toastText = (await toast.textContent().catch(() => '')) ?? ''
  if (toastText.includes('nc')) break
}
check('哨兵 toast 反查出进程名（nc + PID）', /nc\(\d+\)/.test(toastText), toastText)
await win.screenshot({ path: 'shots/97-sentinel-toast.png' })

// ---- ② 点击 toast → 性能监控网络页按端口过滤 ----
await toast.click()
await win.locator('.mon-panel').waitFor({ timeout: 5000 })
await win.waitForTimeout(1500)
const tabNow = (await win.locator('.mon-panel .tab-bar button.active').textContent()) ?? ''
const netFilterVal = await win.locator('.mon-panel .page:visible .filter-row input').inputValue()
check('点击哨兵直达网络页且按端口过滤', tabNow.includes('网络') && netFilterVal === String(SENTINEL_PORT), `tab=${tabNow} filter=${netFilterVal}`)
let connHit = false
for (let i = 0; i < 8 && !connHit; i++) {
  await win.waitForTimeout(1000)
  connHit = (await win.locator('.mon-panel .conn-row', { hasText: `:${SENTINEL_PORT}` }).count()) >= 1
}
check('连接表里看到该监听', connHit)

// ---- ③ 连接行点进程名 → 进程页 PID chip 精确定位 ----
const procCell = win.locator('.mon-panel .conn-row', { hasText: `:${SENTINEL_PORT}` }).first().locator('.n-proc.jump')
const procCellText = ((await procCell.textContent()) ?? '').trim()
await procCell.click()
await win.waitForTimeout(1500)
const tabNow2 = (await win.locator('.mon-panel .tab-bar button.active').textContent()) ?? ''
const pidChip = (await win.locator('.mon-panel .page:visible .pid-chip').textContent().catch(() => '')) ?? ''
const pidNum = /PID (\d+)/.exec(pidChip)?.[1] ?? ''
const targetRow = await win.locator('.mon-panel .page:visible .row', { hasText: 'nc' }).count()
check(
  '连接行点进程名跳进程页（PID chip + 命中 nc 行）',
  tabNow2.includes('进程') && pidNum !== '' && procCellText.includes(pidNum) && targetRow >= 1,
  `tab=${tabNow2} chip=${pidChip} rows=${targetRow}`
)
await win.screenshot({ path: 'shots/98-sentinel-to-proc.png' })

// 清理
await remoteExec(`pkill -f 'nc -lk -p ${SENTINEL_PORT}' 2>/dev/null; true`).catch(() => {})
await remoteExec('rm -rf ~/.dox; true').catch(() => {})
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
ssh.end()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

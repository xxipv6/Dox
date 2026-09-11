/**
 * 直连容器（Dev Containers 式）的端到端验证：
 *  保存设备（不连接）→ 侧栏设备行展开箭头 → 后台传输会话列出容器
 *  （断言全程没有宿主机终端标签）→ 点容器名直接进容器标签 → 终端可交互 →
 *  服务器侧 TCP 连接数 = 基线+1（只有传输会话一条）→
 *  关掉容器标签 + 收起设备行 → 传输会话被回收（连接数回落）→
 *  再展开能重连 → 清理（删除测试设备）。
 *
 * 用法：node scripts/verify-direct-container.mjs [host] [port] [user] [password]
 * 前置：npm run build；dox-sshd-test dind + inner 在跑
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
const DEVICE_NAME = 'dox-direct-test'

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
// 到 sshd 的 ESTABLISHED 连接数（含本夹具自己那一条；只能相对比较）
// 注意容器内 sshd 听的是 2222（不是 22），按实际端口过滤
const connCount = async () => {
  try {
    const out = await remoteExec(`netstat -tn | grep ESTABLISHED | grep -c ':${port} ' || true`)
    return Number(out.trim()) || 0
  } catch {
    return -1
  }
}

await remoteExec(`docker start ${INNER} 2>/dev/null || docker run -d --name ${INNER} alpine sleep 3600`)
console.log('  夹具就绪：inner 运行中')

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

// DOM 渲染器（读 .xterm-rows 需要）；主机指纹对话框可能挡连接，并行点掉
const origSettings = await win.evaluate(() => window.api.getSettings())
if (origSettings && !origSettings.ligatures) {
  await win.evaluate((s) => window.api.setSettings({ ...s, ligatures: true }), origSettings)
  await win.waitForTimeout(600)
}
const hostKeyClicks = (async () => {
  for (let i = 0; i < 120; i++) {
    const hk = await win.evaluate(() =>
      [...document.querySelectorAll('.dialog-header')]
        .map((e) => e.textContent.trim())
        .some((t) => t.includes('主机'))
    )
    if (hk) {
      const btn = win.locator('button:has-text("信任并保存")')
      if (await btn.count()) await btn.click()
    }
    await win.waitForTimeout(500)
  }
})()

// ---- 保存设备（只保存，不连接 —— 证明直连不需要宿主机标签）----
// 前一次跑挂了可能留下同名设备：先清干净，否则行定位会命中多个
for (;;) {
  const stale = win.locator('.device').filter({ hasText: DEVICE_NAME }).first()
  if ((await win.locator('.device').filter({ hasText: DEVICE_NAME }).count()) === 0) break
  await stale.hover()
  await stale.locator('.device-actions button[title="删除"]').click()
  await win.waitForTimeout(600)
}
await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input.port').fill(String(port))
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="留空则用 用户名@主机"]').fill(DEVICE_NAME)
await win.locator('input[placeholder="登录密码"]').fill(password)
// text-is：has-text("保存") 会同时命中「保存」和「保存并连接」
await win.locator('button:text-is("保存")').click()
await win.waitForTimeout(800)

const deviceRow = win.locator('.device').filter({ hasText: DEVICE_NAME })
check('设备已保存并出现在侧栏', (await deviceRow.count()) === 1)

const baseline = await connCount()
console.log(`  基线 sshd 连接数：${baseline}`)

// ---- 展开设备行 → 传输会话列容器 ----
await deviceRow.hover()
await deviceRow.locator('.device-expand').click()
const ctrRow = win.locator('.device-container').filter({ hasText: INNER })
let listed = false
try {
  await ctrRow.waitFor({ timeout: 20000 })
  listed = true
} catch { /* 超时 */ }
check('设备行展开列出容器（后台传输会话）', listed)
check(
  '全程没有宿主机终端标签',
  (await win.locator('.tab-title').filter({ hasText: DEVICE_NAME }).count()) === 0 &&
    (await win.locator('.tab-title').filter({ hasText: `${user}@` }).count()) === 0
)
await win.screenshot({ path: 'shots/80-direct-container-list.png' })

// ---- 点容器名直接进 ----
await ctrRow.click()
const ctrTab = win.locator('.tab-title', { hasText: `容器 · ${INNER}` })
let tabOk = false
try {
  await ctrTab.waitFor({ timeout: 15000 })
  tabOk = true
} catch { /* 超时 */ }
check('点击容器名直接开出容器标签', tabOk)
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 20000 })
await win.keyboard.press('Escape')
// 点击终端拿焦点再敲键盘 —— 标签刚切开时焦点还在侧栏
await win.locator('.terminal-container:visible').first().click()
// 等容器 shell 提示符出来再敲：通道未就绪时输入会被丢掉（dind 里 docker exec 要 1-3s）
let promptReady = false
for (let i = 0; i < 30 && !promptReady; i++) {
  await win.waitForTimeout(500)
  promptReady = await win.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .some((t) => t.includes('/ #'))
  )
}
check('容器 shell 提示符就绪', promptReady)

// 终端可交互：echo 一个算式，读回结果
await win.keyboard.type('echo DOX-$((6*7))')
await win.keyboard.press('Enter')
let echoed = false
for (let i = 0; i < 20 && !echoed; i++) {
  await win.waitForTimeout(500)
  echoed = await win.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .some((t) => t.includes('DOX-42'))
  )
}
check('直连容器终端可交互（echo 回显）', echoed)

// 连接数：基线 + 1（传输会话；docker exec 通道骑在同一条 TCP 上）
await win.waitForTimeout(1000)
const duringUse = await connCount()
check('使用期间连接数 = 基线+1（只有传输会话）', baseline < 0 || duringUse === baseline + 1, `baseline=${baseline} during=${duringUse}`)

// ---- 关容器标签 + 收起设备行 → 传输会话回收 ----
await ctrTab.hover()
await win.locator('.tab', { hasText: `容器 · ${INNER}` }).locator('.tab-close').click()
await win.waitForTimeout(800)
await deviceRow.hover()
await deviceRow.locator('.device-expand').click() // 收起
await win.waitForTimeout(2500)
const afterRelease = await connCount()
check('关标签+收起后传输会话被回收（连接数回落）', baseline < 0 || afterRelease === baseline, `baseline=${baseline} after=${afterRelease}`)

// ---- 再展开：传输会话按需重连 ----
await deviceRow.hover()
await deviceRow.locator('.device-expand').click()
let relisted = false
try {
  await win.locator('.device-container').filter({ hasText: INNER }).waitFor({ timeout: 20000 })
  relisted = true
} catch { /* 超时 */ }
check('收起后再展开能重连并列容器', relisted)
await win.screenshot({ path: 'shots/81-direct-container-relist.png' })
// 收起，把传输会话放掉，进入宿主标签路径的测试
await deviceRow.hover()
await deviceRow.locator('.device-expand').click()
await win.waitForTimeout(2500)

// ---- 阶段 2：宿主标签里进的容器，关掉宿主标签后必须继续活着（孤儿保活）----
await deviceRow.dblclick() // 开宿主终端标签
const hostTab = win.locator('.tab-title', { hasText: DEVICE_NAME })
let hostOk = false
try {
  await hostTab.waitFor({ timeout: 20000 })
  hostOk = true
} catch { /* 超时 */ }
check('双击设备开出宿主终端标签', hostOk)
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 20000 })
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

const ctrHead = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await ctrHead.getAttribute('aria-expanded')) === 'false') {
  await ctrHead.click()
  await win.waitForTimeout(1500)
}
const panelRow = win.locator('.container').filter({ hasText: INNER }).first()
await panelRow.waitFor({ timeout: 15000 })
await panelRow.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
const ctrTab2 = win.locator('.tab-title', { hasText: `容器 · ${INNER}` })
await ctrTab2.waitFor({ timeout: 15000 })
await win.waitForTimeout(2000)

// 关宿主标签 → 容器标签必须还活着且可交互
await hostTab.hover()
await win.locator('.tab', { hasText: DEVICE_NAME }).locator('.tab-close').first().click()
await win.waitForTimeout(1200)
check(
  '宿主标签关闭后容器标签仍在',
  (await win.locator('.tab-title', { hasText: `容器 · ${INNER}` }).count()) === 1
)
await win.locator('.tab-title', { hasText: `容器 · ${INNER}` }).first().click()
await win.waitForTimeout(600)
await win.locator('.terminal-container:visible').first().click()
await win.keyboard.type('echo ORPHAN-$((7*11))')
await win.keyboard.press('Enter')
let orphanEcho = false
for (let i = 0; i < 20 && !orphanEcho; i++) {
  await win.waitForTimeout(500)
  orphanEcho = await win.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .some((t) => t.includes('ORPHAN-77'))
  )
}
check('孤儿保活：宿主标签没了容器终端仍可交互', orphanEcho)
const orphanConn = await connCount()
check('孤儿保活期间连接数 = 基线+1', baseline < 0 || orphanConn === baseline + 1, `baseline=${baseline} orphan=${orphanConn}`)

// 关掉最后的容器标签 → 孤儿连接应被回收
await win.locator('.tab', { hasText: `容器 · ${INNER}` }).locator('.tab-close').click()
await win.waitForTimeout(2500)
const drainedConn = await connCount()
check('最后的容器标签关闭后孤儿连接回收', baseline < 0 || drainedConn === baseline, `baseline=${baseline} drained=${drainedConn}`)

// ---- 清理：删除测试设备 ----
await deviceRow.hover()
await deviceRow.locator('.device-actions button[title="删除"]').click()
await win.waitForTimeout(800)
check('测试设备已删除', (await win.locator('.device').filter({ hasText: DEVICE_NAME }).count()) === 0)

hostKeyClicks.catch(() => {})
ssh.end()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

/**
 * 性能监控面板端到端（全程本机容器）：
 *  本机 alpine 容器 → 装助手 → 右键「性能监控」→
 *  概览：每核格子数 > 0 + 内存条 →
 *  网络：nc 起一个监听，连接表出现 LISTEN:8321（带进程名）→
 *  进程：列出 sleep 3600 → 点 PID 跳网络页且过滤预设 →
 *  老路径回归：右键菜单不再有「进程管理」。
 *
 * 用法：node scripts/verify-monitor.mjs
 * 前置：npm run build && node scripts/build-agent.mjs；本机 docker 可用
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const NAME = 'dox-monitor-verify'
mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* 不在 */ }
execFileSync('docker', ['run', '-d', '--name', NAME, 'alpine', 'sleep', '3600'], { stdio: 'ignore' })
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
await win.waitForTimeout(2500)

const ctrHead = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await ctrHead.getAttribute('aria-expanded')) === 'false') {
  await ctrHead.click()
  await win.waitForTimeout(1500)
}
const row = win.locator('.container').filter({ hasText: NAME }).first()
await row.waitFor({ timeout: 15000 })
await row.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
await win.waitForTimeout(3000)

const agentHead = win.locator('.sidebar .section-head', { hasText: '助手' })
if ((await agentHead.getAttribute('aria-expanded')) === 'false') {
  await agentHead.click()
  await win.waitForTimeout(800)
}
await win.locator('button', { hasText: `安装到容器 ${NAME}` }).click()
let installOk = false
try {
  await win.locator('.sidebar .agent-ok', { hasText: '已安装' }).waitFor({ timeout: 30000 })
  installOk = true
} catch { /* 超时 */ }
check('助手安装成功（当前内置版本）', installOk)

// nc 监听一个端口，让连接表有东西可看
await win.evaluate(async (name) => {
  await window.api.agentCall('local', name, 'exec', {
    argv: ['sh', '-c', 'nc -l -p 8321 >/dev/null 2>&1 &']
  })
}, NAME)

// ---- 右键 → 性能监控 ----
await win.locator('.terminal-container:visible').first().click({ button: 'right' })
await win.waitForTimeout(400)
const menuText = await win.locator('.context-menu').textContent()
check('右键菜单是「性能监控」（不再有「进程管理」）',
  (menuText ?? '').includes('性能监控') && !(menuText ?? '').includes('进程管理'), menuText ?? '')
await win.locator('.context-menu button', { hasText: '性能监控' }).click()
await win.locator('.mon-panel').waitFor({ timeout: 5000 })

// ---- 概览：每核格子 + 内存条 ----
// 埋事件钩子：概览没数时能看到帧到底来没来
await win.evaluate(() => {
  window.__statsEvents = []
  window.api.onAgentStats((id, ctr, data) => {
    window.__statsEvents.push([ctr, data.event, data.cpus?.length ?? null])
  })
})
let coreCount = 0
for (let i = 0; i < 15 && coreCount === 0; i++) {
  await win.waitForTimeout(1000)
  coreCount = await win.locator('.mon-panel .core-box').count()
}
if (coreCount === 0) {
  const dump = await win.evaluate(() => window.__statsEvents)
  console.log('  stats 事件流:', JSON.stringify(dump))
}
check('概览：每核格子出现', coreCount > 0, `cores=${coreCount}`)
check('概览：内存条出现', (await win.locator('.mon-panel .big-bar').count()) >= 1)
await win.screenshot({ path: 'shots/95-monitor-overview.png' })

// ---- 网络：连接表出现 LISTEN 8321 ----
await win.locator('.mon-panel .tab-bar button', { hasText: '网络' }).click()
let connHit = false
for (let i = 0; i < 10 && !connHit; i++) {
  await win.waitForTimeout(1200)
  connHit = (await win.locator('.mon-panel .conn-row', { hasText: ':8321' }).count()) >= 1
}
check('网络：nc 监听出现在连接表（:8321）', connHit)
if (connHit) {
  const rowText = await win.locator('.mon-panel .conn-row', { hasText: ':8321' }).first().textContent()
  check('连接行带状态与进程名', /LISTEN/.test(rowText ?? '') && /nc/.test(rowText ?? ''), (rowText ?? '').slice(0, 120))
}
await win.screenshot({ path: 'shots/96-monitor-network.png' })

// ---- 进程：列出主进程 → 点 PID 跳网络页 ----
await win.locator('.mon-panel .tab-bar button', { hasText: '进程' }).click()
await win.waitForTimeout(2500)
check(
  '进程页列出 sleep 3600',
  (await win.locator('.mon-panel .page:visible .row', { hasText: 'sleep 3600' }).count()) >= 1
)
const pidCell = win.locator('.mon-panel .page:visible .row', { hasText: 'sleep 3600' }).first().locator('.c-pid.jump')
const pidText = (await pidCell.textContent())?.trim() ?? ''
await pidCell.click()
await win.waitForTimeout(600)
const tabNow = await win.locator('.mon-panel .tab-bar button.active').textContent()
// PID 过滤走独立的精确匹配 chip（全文框会被 :443 这类端口子串污染），搜索框保持为空
const chipText = (await win.locator('.mon-panel .pid-chip').textContent().catch(() => '')) ?? ''
const connFilterVal = await win.locator('.mon-panel .page:visible .filter-row input').first().inputValue()
check(
  '点 PID 跳网络页且出精确过滤 chip',
  (tabNow ?? '').includes('网络') && chipText.includes(pidText) && connFilterVal === '',
  `tab=${tabNow} chip=${chipText} filter=${connFilterVal} pid=${pidText}`
)

// ---- 面板拖宽：左缘往左拖 160px → 变宽且写进设置 ----
const beforeW = (await win.locator('.mon-panel').boundingBox())?.width ?? 0
const handle = win.locator('.mon-panel .resize-handle')
const hb = await handle.boundingBox()
if (hb) {
  await win.mouse.move(hb.x + hb.width / 2, hb.y + 200)
  await win.mouse.down()
  await win.mouse.move(hb.x - 160, hb.y + 200, { steps: 5 })
  await win.mouse.up()
}
await win.waitForTimeout(400)
const afterW = (await win.locator('.mon-panel').boundingBox())?.width ?? 0
check('拖左缘面板变宽', afterW > beforeW + 100, `${beforeW} -> ${afterW}`)
const persistedW = await win.evaluate(async () => (await window.api.getSettings()).monitorWidth)
check('宽度写进设置', Math.abs((persistedW ?? 0) - afterW) < 2, `persisted=${persistedW} actual=${afterW}`)
// 恢复默认宽度，别污染后续脚本
await win.evaluate(async () => {
  const s = await window.api.getSettings()
  await window.api.setSettings({ ...s, monitorWidth: 440 })
})

// ---- 关掉发起标签 → 面板必须一起收（否则概览定格假数据、本机容器轮询泄漏 agent 通道）----
// 走真实 UI：标签条上的关闭按钮
const activeTabClose = win.locator('.tab.active .tab-close, .tab.active button[title="关闭"]').first()
if ((await activeTabClose.count()) > 0) {
  await activeTabClose.click()
} else {
  // 退路：直接调 store 关活跃标签
  await win.evaluate(() => {
    const tabs = document.querySelectorAll('.tab')
    tabs[tabs.length - 1]?.querySelector('.tab-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
await win.waitForTimeout(800)
check('关闭发起标签后面板一起收', (await win.locator('.mon-panel').count()) === 0)

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* 清理尽力而为 */ }

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

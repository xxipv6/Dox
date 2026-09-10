/**
 * 容器生命周期（启动/停止/删除 + 全状态列表）的端到端验证（本机路径）：
 * 建一个已停止的测试容器 → UI 里看到它（淡显）→ 右键启动 → 圆点变绿 →
 * 右键停止（确认框）→ 圆点变灰 → 右键删除 → 行消失。
 *
 * 用法：node scripts/verify-container-lifecycle.mjs
 * 前置：npm run build；本机 docker/podman 可用。
 * 测试容器（dox-lifecycle-test）由本脚本创建、结束时保证删掉。
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('shots', { recursive: true })
const NAME = 'dox-lifecycle-test'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 20000 }).trim()
}
try {
  docker('version', '--format', '{{.Server.Version}}')
} catch {
  console.log('本机 docker 不可用，跳过')
  process.exit(0)
}
try {
  docker('rm', '-f', NAME)
} catch {
  /* 不存在 */
}
// 已停止的容器：create 不启动。注意必须是「启动后能一直活」的命令 ——
// alpine true 一启动立刻退出，「启动后圆点变 running」永远等不到（踩过）
docker('create', '--name', NAME, 'alpine', 'sleep', '300')
console.log('已停止的测试容器就绪:', NAME)

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept()) // 自动确认 stop/remove 的 confirm
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

/*
 * 侧栏分区默认收起（SidebarSection open 默认 false），行在 DOM 里但不可见 ——
 * evaluate 能读到、click 全部超时。按 aria-expanded 决定是否展开（照 verify-container.mjs）。
 */
const sectionHead = win.locator('.sidebar .section-head', { hasText: '容器' })
await sectionHead.waitFor({ timeout: 10000 })
if ((await sectionHead.getAttribute('aria-expanded')) === 'false') {
  await sectionHead.click()
  await win.waitForTimeout(600)
}

async function rowState() {
  return win.evaluate((name) => {
    const row = [...document.querySelectorAll('.container')].find((el) =>
      el.querySelector('.container-name')?.textContent.trim() === name
    )
    if (!row) return null
    return {
      dot: row.querySelector('.dot')?.className ?? '',
      stopped: row.classList.contains('stopped')
    }
  }, NAME)
}

async function waitRowState(pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let st = null
  while (Date.now() < deadline) {
    st = await rowState()
    if (st && pred(st)) return st
    await win.waitForTimeout(500)
  }
  return st
}

async function menuLabels() {
  return win.evaluate(() =>
    [...document.querySelectorAll('.context-menu .menu-item')].map((b) => b.textContent.trim())
  )
}

async function rightClickRow() {
  await win.locator('.container').filter({ hasText: NAME }).first().click({ button: 'right' })
  await win.waitForTimeout(400)
}

async function clickMenu(label) {
  await win.locator('.context-menu .menu-item').filter({ hasText: label }).first().click()
}

// 等测试容器出现在列表里
let st = await waitRowState((s) => s !== null)
if (!st) {
  await win.locator('button[title="刷新容器列表"]').click().catch(() => {})
  st = await waitRowState((s) => s !== null)
}
check('已停止容器出现在列表里', !!st)
check('已停止容器淡显（stopped 样式）', st?.stopped === true, st?.dot)

// 右键：已停止 → 启动/查看日志/删除，且没有「进入」
await rightClickRow()
let labels = await menuLabels()
check('停止状态菜单 = 启动/查看日志/删除',
  labels.some((l) => l.includes('启动')) && labels.some((l) => l.includes('查看日志')) &&
  labels.some((l) => l.includes('删除')) && !labels.some((l) => l.includes('进入')),
  labels.join(','))

// 启动
await clickMenu('启动')
await win.waitForTimeout(1000)
st = await waitRowState((s) => s.dot.includes('running'), 8000)
check('启动后圆点变 running', st?.dot.includes('running') ?? false, JSON.stringify(st))

// 右键：运行中 → 进入/查看日志/停止
await rightClickRow()
labels = await menuLabels()
check('运行状态菜单 = 进入/查看日志/停止',
  labels.some((l) => l.includes('进入')) && labels.some((l) => l.includes('查看日志')) &&
  labels.some((l) => l.includes('停止')) && !labels.some((l) => l.includes('删除')),
  labels.join(','))

// 停止（confirm 自动确认）
await clickMenu('停止')
st = await waitRowState((s) => s.stopped)
check('停止后回到淡显', st?.stopped === true, JSON.stringify(st))
await win.screenshot({ path: join('shots', '33-container-lifecycle.png') })

// 删除（confirm 自动确认）
await rightClickRow()
await clickMenu('删除')
const gone = await waitRowState((s) => s === null || undefined, 8000)
// waitRowState 在 pred 为 null 时不适用，直接轮询不存在
let exists = true
for (let i = 0; i < 12; i++) {
  exists = (await rowState()) !== null
  if (!exists) break
  await win.waitForTimeout(500)
}
check('删除后从列表消失', !exists)

// ---------- 清理 ----------
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
try {
  docker('rm', '-f', NAME)
} catch {
  /* 已被 UI 删掉是预期结果 */
}
console.log(failed ? '\n有断言未通过' : '\n全部通过')
process.exit(failed ? 1 : 0)

/**
 * 容器「查看日志」端到端（本机路径）：启动一个持续吐日志的容器，
 * 真实 UI 里右键 → 查看日志 → 断言「日志 · <名字>」标签开出且保持 connected
 * （docker logs 失败的话通道会立即关闭，标签会掉出 connected，这就是判据）。
 *
 * 用法：node scripts/verify-container-logs.mjs
 * 前置：npm run build；本机有 docker/podman（colima / Docker Desktop 均可）。
 * 会在本机建一个临时容器（dox-logs-test），结束时自己删掉。
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('shots', { recursive: true })
const NAME = 'dox-logs-test'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---------- 准备：一个持续吐日志的容器 ----------
function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 15000 }).trim()
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
docker('run', '-d', '--name', NAME, 'alpine', 'sh', '-c',
  'while true; do echo "dox-log-line alive"; sleep 2; done')
console.log('测试容器已启动:', NAME)

const CONTAINER_TAB_PREFIX = '日志 · '

async function logsTabDot() {
  return win.evaluate((prefix) => {
    const t = [...document.querySelectorAll('.tab')].find((el) =>
      el.textContent.includes(prefix)
    )
    return t ? (t.querySelector('.status-dot')?.className ?? '') : null
  }, CONTAINER_TAB_PREFIX)
}

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
// 清布局与 reload 放同一次 evaluate：布局 store 有 400ms 防抖自动保存
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

// 默认本地终端标签 → 容器面板列的是本机容器；等测试容器出现在列表里
let listed = false
for (let i = 0; i < 10; i++) {
  const found = await win.evaluate((name) =>
    [...document.querySelectorAll('.container .container-name')].some(
      (el) => el.textContent.trim() === name
    ), NAME)
  if (found) { listed = true; break }
  // 面板是手动刷新模型，列表没出来时戳一下刷新
  await win.locator('button[title="刷新容器列表"]').click().catch(() => {})
  await win.waitForTimeout(1200)
}
check('容器列表里能看到测试容器', listed)

if (listed) {
  // 右键 → 查看日志
  const row = win.locator('.container').filter({ hasText: NAME }).first()
  await row.click({ button: 'right' })
  await win.waitForTimeout(400)
  const menuItem = win.locator('.context-menu button, .menu button').filter({ hasText: '查看日志' }).first()
  check('右键菜单有「查看日志」', (await menuItem.count()) > 0)
  await menuItem.click()

  // 等标签到 connected（docker logs -f 活着 → 通道不关 → 一直 connected）
  let dot = null
  const deadline = Date.now() + 16000
  while (Date.now() < deadline) {
    dot = await logsTabDot()
    if (dot?.includes('connected')) break
    await win.waitForTimeout(400)
  }
  check('日志标签开出且 connected', dot?.includes('connected') ?? false, String(dot))

  // 再等 3 秒确认流没断（命令失败的话此时已 closed）
  await win.waitForTimeout(3000)
  const dot2 = await logsTabDot()
  check('3 秒后日志流仍在', dot2?.includes('connected') ?? false, String(dot2))

  await win.screenshot({ path: join('shots', '31-container-logs.png') })

  // 再点一次「查看日志」：应聚焦已有标签而不是堆第二个
  await row.click({ button: 'right' })
  await win.waitForTimeout(400)
  await win.locator('.context-menu button, .menu button').filter({ hasText: '查看日志' }).first().click()
  await win.waitForTimeout(800)
  const tabCount = await win.evaluate((prefix) =>
    [...document.querySelectorAll('.tab')].filter((el) => el.textContent.includes(prefix)).length,
    CONTAINER_TAB_PREFIX)
  check('重复点不堆第二个日志标签', tabCount === 1, `实际 ${tabCount} 个`)
}

// ---------- 清理 ----------
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
try {
  docker('rm', '-f', NAME)
} catch {
  /* 尽力而为 */
}
console.log(failed ? '\n有断言未通过' : '\n全部通过')
process.exit(failed ? 1 : 0)

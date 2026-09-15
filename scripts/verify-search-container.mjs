/**
 * 项目模式全文搜索 —— 容器内 e2e（agent 是容器里唯一的引擎：没装/过旧 = 报错指路，绝不回退）。
 *
 * 在测试机（SSH 可达、装有 docker）上起一个一次性 alpine 容器 → 侧栏进容器 →
 * 面板装容器助手（opt-in UI）→ 容器里造夹具 → 项目模式搜索 → 徽章必须是「助手」→
 * 点匹配经 agent 读出容器内文件 → 收尾 docker rm -f + 删夹具。
 *
 * 用法：node scripts/verify-search-container.mjs [host] [port] [user]
 * 密码：环境变量 DOX_TEST_PASS。前置：npm run build。
 * 注意：本机没有 docker —— 容器一律起在 SSH 测试机上，绝不在本地起。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const host = process.argv[2] ?? process.env.DOX_TEST_HOST ?? '192.168.3.5'
const port = process.argv[3] ?? '22'
const user = process.argv[4] ?? process.env.DOX_TEST_USER ?? 'root'
const pass = process.env.DOX_TEST_PASS
if (!pass) {
  console.error('缺少 DOX_TEST_PASS（SSH 密码）')
  process.exit(2)
}

const CTR = 'dox-e2e-csearch'
const REMOTE_BASE = '/tmp/dox-e2e-csearch' // SSH 宿主机上的夹具目录（docker exec 数据源）

mkdirSync('shots', { recursive: true })
let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

try {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { stdio: 'ignore' })
  } else {
    execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
  }
} catch { /* 没有正好 */ }

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
const origSettings = await win.evaluate(() => window.api.getSettings())
await win.evaluate(async (s) => {
  await window.api.setSettings({ ...s, projectRoots: {} })
  await window.api.setLayout({ tabs: [] })
  location.reload()
}, origSettings)
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const rowWith = (sel, text) =>
  win.locator(sel).filter({ has: win.locator(`.file-name:text-is("${text}")`) }).first()

const termText = () =>
  win.evaluate(() => {
    const tas = [...document.querySelectorAll('.xterm')].filter((t) => t.offsetParent !== null)
    return tas.map((t) => (t.textContent ?? '').replace(/\s+/g, ' ')).join('|')
  })

async function run(cmd, waitMs = 1500) {
  await win.locator('.tab-content:visible .xterm-helper-textarea').first().click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(waitMs)
}

const statusText = async () =>
  (await win.locator('.search-panel .search-status').first().textContent().catch(() => '')) ?? ''
async function waitMatchCount(timeoutMs = 20000, prevText = '') {
  const started = Date.now()
  for (;;) {
    const t = await statusText()
    const m = /(\d+) 条结果/.exec(t)
    if (m && t !== prevText) return { count: Number(m[1]), text: t }
    const err = await win.locator('.search-panel .search-status.error').count()
    if (err) return { count: -1, text: t }
    if (Date.now() - started > timeoutMs) return { count: -1, text: t }
    await win.waitForTimeout(300)
  }
}

try {
  // ---- 1. 连 SSH ----
  await win.locator('button[title="添加设备"]').click()
  await win.waitForTimeout(500)
  await win.locator('input[placeholder^="192.168"]').fill(host)
  await win.locator('input[placeholder="root"]').fill(user)
  await win.locator('input[placeholder="登录密码"]').fill(pass)
  // 保存并连接：容器列表挂在已保存设备行下，「仅连接」不进设备列表
  await win.locator('button:has-text("保存并连接")').click()
  let connected = false
  for (let i = 0; i < 30 && !connected; i++) {
    await win.waitForTimeout(1000)
    const headers = await win.evaluate(() =>
      [...document.querySelectorAll('.overlay .dialog-header')].map((e) => e.textContent?.trim() ?? ''))
    if (headers.some((t) => t.includes('主机'))) {
      await win.locator('button:has-text("信任并保存")').click()
      continue
    }
    connected = (await termText()).includes('root@')
  }
  check('SSH 连上（终端出 prompt）', connected, (await termText()).slice(-80))

  // ---- 2. 测试机上起一次性容器（本地没有 docker，容器只在远端起）----
  await run(`docker rm -f ${CTR} 2>/dev/null; docker run -d --name ${CTR} alpine sleep 900`, 3000)
  await run(`docker exec ${CTR} sh -c 'mkdir -p /work/sub && printf "Hello world\\nnothing\\n" > /work/a.txt && printf "hello from b\\n" > /work/sub/b.txt && mkdir -p /work/node_modules && printf "hello nm\\n" > /work/node_modules/x.js'`, 1500)
  await run(`docker exec ${CTR} ls /work /work/sub`, 800)
  const fixtureOut = await termText()
  check('容器内夹具就位（a.txt/sub/b.txt）',
    /a\.txt/.test(fixtureOut) && /b\.txt/.test(fixtureOut), fixtureOut.slice(-160))

  // ---- 3. 设备行展开容器列表 → 单击进容器（新容器标签）----
  const deviceRow = win.locator('.sidebar .device').filter({ hasText: host }).first()
  await deviceRow.waitFor({ timeout: 10000 })
  await deviceRow.locator('.device-expand').click()
  const ctrRow = win.locator('.sidebar .device-container').filter({ hasText: CTR }).first()
  await ctrRow.waitFor({ timeout: 15000 })
  await ctrRow.click()
  // 容器标签出现：终端栏冒出「容器文件面板（经容器助手）」按钮
  const ctrFileBtn = win.locator('button.bar-btn[title="容器文件面板（经容器助手）"]')
  await ctrFileBtn.waitFor({ timeout: 20000 })
  check('进入容器标签（容器文件按钮在）', (await ctrFileBtn.count()) === 1)

  // ---- 4. 容器助手：面板装（opt-in UI，目标自动切到该容器）----
  await ctrFileBtn.click()
  await win.waitForTimeout(1200)
  const agentHead = win.locator('.sidebar .section-head').filter({ hasText: /远程助手|助手 ·/ }).first()
  await agentHead.click()
  await win.waitForTimeout(1000)
  const installBtn = win.locator('.sidebar .agent-panel button.btn.primary, .sidebar button.btn.primary')
    .filter({ hasText: /安装到容器/ }).first()
  if ((await installBtn.count()) === 1) {
    await installBtn.click()
    let installed = false
    for (let i = 0; i < 40 && !installed; i++) {
      await win.waitForTimeout(1000)
      installed = /已安装 v0\.7\./.test(
        (await win.locator('.sidebar .agent-ok').textContent().catch(() => '')) ?? '')
    }
    check('容器助手安装到 v0.7.x', installed,
      (await win.locator('.sidebar .agent-ok').textContent().catch(() => '')) ?? '')
  } else {
    check('容器助手已是 v0.7.x', /已安装 v0\.7\./.test(
      (await win.locator('.sidebar .agent-ok').textContent().catch(() => '')) ?? ''))
  }
  await agentHead.click().catch(() => undefined)

  // ---- 5. 容器文件面板 → 右键 work 目录进项目模式（根 = /work）----
  await win.locator('.explorer .file-list .row, .explorer .agent-guide, .explorer .hint')
    .first().waitFor({ timeout: 15000 })
  await win.locator('.explorer .breadcrumb a.crumb[title="/"]').click()
  await win.waitForTimeout(1200)
  // 不进 /work：从 / 右键 work 行，项目根才是整个 /work（进去了再右键空白
  // 会落到列表第一行上 —— 目录排在最前，根就变成了那个子目录）
  await rowWith('.explorer .file-list .row', 'work').click({ button: 'right' })
  const enterItem = win.locator('.context-menu .menu-item', { hasText: '进入项目模式' })
  check('右键含「进入项目模式」', (await enterItem.count()) === 1)
  await enterItem.click()
  await win.locator('.explorer .project-bar').waitFor({ timeout: 5000 })

  // ---- 6. 搜索（容器里 agent 是唯一引擎，徽章必须是「助手」）----
  await win.locator('.explorer .project-rail button[title^="在项目中搜索"]').click()
  await win.locator('.search-panel .search-input').waitFor({ timeout: 5000 })
  await win.locator('.search-panel .search-input').fill('hello')
  const first = await waitMatchCount(30000)
  check('容器内搜索结果计数（2 条：a.txt 的 Hello + b.txt）', first.count === 2, first.text)
  const groupPaths = (await win.locator('.search-panel .group-path').allTextContents()).join('|')
  check('node_modules 不出现', !groupPaths.includes('node_modules'), groupPaths)
  const badge = (await win.locator('.search-panel .engine-badge').textContent().catch(() => '')) ?? ''
  check('引擎徽章 = 助手（容器不回退）', badge.trim() === '助手',
    `badge="${badge}" status="${first.text}"`)

  // ---- 7. 点匹配 → 容器内文件经 agent 进编辑器 ----
  await win.locator('.search-panel .search-group', { hasText: 'b.txt' }).locator('.search-match').first().click()
  await win.locator('.editor-panel .etab', { hasText: 'b.txt' }).waitFor({ timeout: 15000 })
  await win.waitForTimeout(500)
  const editorBody = (await win.locator('.editor-panel .cm-content').textContent().catch(() => '')) ?? ''
  check('容器内内容读到了（hello from b）', editorBody.includes('hello from b'), editorBody.slice(0, 60))

  await win.screenshot({ path: 'shots/search-container.png' })
} catch (err) {
  console.log('  FAIL 异常中断', err)
  failed = true
  try {
    await win.screenshot({ path: 'shots/search-container-fail.png' })
    console.log('终端尾部：', (await termText()).slice(-300))
  } catch { /* 截图也失败就算了 */ }
} finally {
  try {
    await run(`docker rm -f ${CTR}`, 800)
    await run(`rm -rf ${REMOTE_BASE}`, 800)
  } catch { /* 连接没起来就没什么可清 */ }
  try {
    if (origSettings) {
      await win.evaluate((s) => window.api.setSettings({ ...s, projectRoots: {} }), origSettings)
    }
  } catch { /* 实例可能已死 */ }
  await app.close().catch(() => undefined)
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

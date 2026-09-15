/**
 * 项目模式全文搜索 —— SSH 远端 e2e（verify-search.mjs 只覆盖本机 node 引擎）。
 *
 * 连真实测试机 → 终端里造夹具 → 浏览面板进项目模式 → 搜索 →
 * 引擎徽章（agent/rg/grep，只要不是 node/报错）→ 分组/排除 →
 * 点匹配打开远端文件 → Aa / 正则 → 收尾清理远端夹具。
 *
 * 用法：node scripts/verify-search-remote.mjs [host] [port] [user]
 * 密码：环境变量 DOX_TEST_PASS（不进仓库）。
 * 前置：npm run build。容器内搜索另测（本机没有 docker，不要在本地起容器）。
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

mkdirSync('shots', { recursive: true })
let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const REMOTE_BASE = '/tmp/dox-e2e-rsearch'

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

/** 终端里跑一条命令：点终端 → 打字 → 等 prompt 回来（以 # / $ 结尾出现新内容为准） */
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
  await win.locator('button:has-text("仅连接")').click()

  // 指纹弹窗（首次连接才有）→ 信任并保存
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

  // ---- 1.5 升级远程助手到内置版本（搜索的 agent 引擎要 ≥0.7.0；测试机上常驻旧版）----
  // opt-in 红线：装/升只能走 UI 里的显式按钮，脚本同样走这条正路
  const agentHead = win.locator('.sidebar .section-head').filter({ hasText: /远程助手|助手 ·/ }).first()
  await agentHead.click()
  await win.waitForTimeout(800)
  const upgradeBtn = win.locator('.agent-upgrade button')
  if ((await upgradeBtn.count()) === 1) {
    await upgradeBtn.click()
    let upgraded = false
    for (let i = 0; i < 40 && !upgraded; i++) {
      await win.waitForTimeout(1000)
      upgraded = /已安装 v0\.7\./.test(
        (await win.locator('.agent-ok').textContent().catch(() => '')) ?? '')
    }
    check('远程助手升级到 v0.7.x', upgraded,
      (await win.locator('.agent-ok').textContent().catch(() => '')) ?? '')
  } else {
    check('远程助手已是 v0.7.x（无需升级）', /已安装 v0\.7\./.test(
      (await win.locator('.agent-ok').textContent().catch(() => '')) ?? ''))
  }
  // 收起分区，免得挡后面的面板
  await agentHead.click().catch(() => undefined)

  // ---- 2. 造夹具 ----
  await run(`rm -rf ${REMOTE_BASE} && mkdir -p ${REMOTE_BASE}/sub/deep ${REMOTE_BASE}/node_modules`)
  await run(`printf 'Hello world\\nnothing\\nsay HELLO again\\n' > ${REMOTE_BASE}/a.txt`)
  await run(`printf 'hello from b\\n' > ${REMOTE_BASE}/sub/b.txt`)
  await run(`printf 'hello from c\\n' > ${REMOTE_BASE}/sub/deep/c.log`)
  await run(`printf 'hello from nm\\n' > ${REMOTE_BASE}/node_modules/x.js`)
  await run(`printf 'hello\\000binary\\n' > ${REMOTE_BASE}/bin.dat`)
  await run(`ls -R ${REMOTE_BASE} | head -20`, 1200)
  const lsOut = await termText()
  check('夹具就位（a.txt/sub 在列）', /a\.txt/.test(lsOut) && /sub/.test(lsOut), lsOut.slice(-200))

  // ---- 3. 面板进项目模式 ----（SSH 标签的按钮叫 SFTP，本机标签才叫 文件）
  await win.locator('button.bar-btn[title="SFTP 文件面板"]').click()
  await win.locator('.explorer .file-list .row').first().waitFor({ timeout: 15000 })
  await win.locator('.explorer .breadcrumb a.crumb[title="/"]').click()
  await win.waitForTimeout(1000)
  await rowWith('.explorer .file-list .row', 'tmp').dblclick()
  await win.waitForTimeout(1500)
  await rowWith('.explorer .file-list .row', 'dox-e2e-rsearch').waitFor({ timeout: 10000 })
  await rowWith('.explorer .file-list .row', 'dox-e2e-rsearch').click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '进入项目模式' }).click()
  await win.locator('.explorer .project-bar').waitFor({ timeout: 5000 })
  check('远端项目模式顶栏', ((await win.locator('.explorer .project-bar').textContent()) ?? '')
    .includes('dox-e2e-rsearch'))

  // ---- 4. 搜索 ----
  await win.locator('.explorer .project-rail button[title^="在项目中搜索"]').click()
  await win.locator('.search-panel .search-input').waitFor({ timeout: 5000 })
  await win.locator('.search-panel .search-input').fill('hello')
  const first = await waitMatchCount(30000)
  check('远端搜索结果计数（4 条）', first.count === 4, first.text)
  check('结果分组成 3 个文件', (await win.locator('.search-panel .search-group').count()) === 3)
  const groupPaths = (await win.locator('.search-panel .group-path').allTextContents()).join('|')
  check('node_modules 与二进制不出现',
    !groupPaths.includes('node_modules') && !groupPaths.includes('bin.dat'), groupPaths)
  const badge = (await win.locator('.search-panel .engine-badge').textContent().catch(() => '')) ?? ''
  check('引擎徽章 = 助手（agent fs_search）', badge.trim() === '助手',
    `badge="${badge}" status="${first.text}"`)

  // ---- 5. 点匹配 → 远端文件进编辑器 ----
  await win.locator('.search-panel .search-group', { hasText: 'b.txt' }).locator('.search-match').first().click()
  await win.locator('.editor-panel .etab', { hasText: 'b.txt' }).waitFor({ timeout: 15000 })
  check('点匹配打开远端文件', (await win.locator('.editor-panel .etab', { hasText: 'b.txt' }).count()) === 1)
  await win.waitForTimeout(500)
  const editorBody = (await win.locator('.editor-panel .cm-content').textContent().catch(() => '')) ?? ''
  check('远端内容读到了（hello from b）', editorBody.includes('hello from b'), editorBody.slice(0, 60))

  // ---- 6. Aa / 正则 ----
  await win.locator('.search-panel button[title="大小写敏感"]').click()
  const sensitive = await waitMatchCount(20000, first.text)
  check('大小写敏感后结果变少（2 条）', sensitive.count === 2, sensitive.text)
  await win.locator('.search-panel button[title="大小写敏感"]').click()
  await win.locator('.search-panel button[title="使用正则表达式"]').click()
  await win.locator('.search-panel .search-input').fill('h.llo')
  const regex = await waitMatchCount(20000, sensitive.text)
  check('正则搜索（4 条）', regex.count === 4, regex.text)

  await win.screenshot({ path: 'shots/search-remote.png' })
} catch (err) {
  console.log('  FAIL 异常中断', err)
  failed = true
  try {
    await win.screenshot({ path: 'shots/search-remote-fail.png' })
    console.log('终端尾部：', (await termText()).slice(-300))
  } catch { /* 截图也失败就算了 */ }
} finally {
  // 远端清理（连接可能没建成，失败就算了）
  try {
    await run(`rm -rf ${REMOTE_BASE}`, 800)
  } catch { /* 连接没起来就没有夹具 */ }
  try {
    if (origSettings) {
      await win.evaluate((s) => window.api.setSettings({ ...s, projectRoots: {} }), origSettings)
    }
  } catch { /* 实例可能已死 */ }
  await app.close().catch(() => undefined)
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

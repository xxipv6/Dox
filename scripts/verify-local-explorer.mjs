/**
 * 本地终端文件面板端到端：
 *  本地标签 →「文件」按钮 → 本机面板（徽章/家目录落地）→ 进测试目录 →
 *  新建文件夹 / 重命名 / 编辑器改存 / 删除 全链路（都落到真实磁盘校验）→
 *  「在终端打开」cd 断言 → enqueueDropped 本机复制（队列 + 磁盘双重校验）→
 *  目录历史后退 → 磁盘用量条出现。
 *
 * 用法：node scripts/verify-local-explorer.mjs
 * 前置：npm run build。测试目录在 $HOME/dox-e2e-local，结束自清理。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---- 磁盘夹具：$HOME/dox-e2e-local/{sub/c.txt, a.txt} ----
const base = path.join(os.homedir(), 'dox-e2e-local')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(path.join(base, 'sub'), { recursive: true })
fs.mkdirSync(path.join(base, 'copydst'))
fs.writeFileSync(path.join(base, 'a.txt'), 'hello-local')
fs.writeFileSync(path.join(base, 'sub', 'c.txt'), 'x')

// 上次跑挂可能留下僵尸实例：共享锁（单实例 CLI）与布局文件都会污染本次运行。
// 只能杀本仓库的 electron（别的 verify 脚本/ dev 同时跑本来就会互相踩）
try {
  if (process.platform === 'win32') {
    // Windows 没有 pkill：按可执行路径匹配本仓库的 electron（taskkill /IM 会误杀别的 Electron 应用）
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
// 读终端文本要走 DOM 渲染器（WebGL 把字画在 canvas 上，.xterm-rows 是空的）。
// 设置存主进程、渲染层 store 只在启动时 load 一次 —— ligatures 必须赶在
// 第一次 reload 之前写，收尾恢复
const origSettings = await win.evaluate(() => window.api.getSettings())
if (origSettings && !origSettings.ligatures) {
  await win.evaluate((s) => window.api.setSettings({ ...s, ligatures: true }), origSettings)
  await win.waitForTimeout(300)
}
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

try {
  // ---- 默认目录设置：设成测试目录 → 新开本地终端落在那（标签名带目录名）----
  // 注意必须同时清布局：布局恢复（带 cwd 的快照）优先于默认目录 ——
  // 上一个标签的 cwd 已经 autosave 进快照，不清掉的话恢复的是旧 cwd，
  // 根本轮不到默认目录出场（这条检查曾因此时好时坏）
  await win.evaluate(async (dir) => {
    const s = await window.api.getSettings()
    await window.api.setSettings({ ...s, localDefaultDir: dir })
    await window.api.setLayout({ tabs: [] })
    location.reload()
  }, base)
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)
  let fellIntoDefault = false
  for (let i = 0; i < 10; i++) {
    const t = (await win.locator('.tab').first().textContent()) ?? ''
    if (t.includes('dox-e2e-local')) { fellIntoDefault = true; break }
    await win.waitForTimeout(500)
  }
  check('默认目录设置生效（新终端落在默认目录）', fellIntoDefault)
  // 清掉设置再重来，后续用例从家目录出发
  await win.evaluate(async () => {
    const s = await window.api.getSettings()
    await window.api.setSettings({ ...s, localDefaultDir: '' })
    location.reload()
  })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)

  // ---- 开面板 ----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  check('本机徽章出现', await win.locator('.explorer .ctr-badge', { hasText: '本机' }).count() === 1)

  // ---- 进测试目录（家目录里 dblclick）----
  await win.locator('.explorer .row', { hasText: 'dox-e2e-local' }).first().dblclick()
  await win.waitForTimeout(1200)
  const crumb = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('进入测试目录', crumb.includes('dox-e2e-local'), crumb)
  check('列出子目录与文件',
    (await win.locator('.explorer .row', { hasText: 'sub' }).count()) > 0 &&
    (await win.locator('.explorer .row', { hasText: 'a.txt' }).count()) > 0)

  // ---- 新建文件夹 ----
  await win.locator('.explorer button[title="新建文件夹"]').click()
  await win.locator('.explorer .rename-input').fill('made')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(800)
  check('新建文件夹落盘', fs.existsSync(path.join(base, 'made')))

  // ---- 重命名 a.txt → b.txt ----
  await win.locator('.explorer .row', { hasText: 'a.txt' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '重命名' }).click()
  await win.locator('.explorer .rename-input').fill('b.txt')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(800)
  check('重命名落盘', fs.existsSync(path.join(base, 'b.txt')) && !fs.existsSync(path.join(base, 'a.txt')))

  // ---- 重命名输入框：挂载必须聚焦（autofocus 对二次插入不可靠，曾因此点别处不消失）----
  await win.locator('.explorer .row', { hasText: 'b.txt' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '重命名' }).click()
  await win.waitForTimeout(300)
  check(
    '重命名输入框挂载即聚焦',
    await win.evaluate(() => document.activeElement?.classList.contains('rename-input'))
  )
  await win.locator('.terminal-container').first().click()
  await win.waitForTimeout(400)
  check('点击终端后输入框消失（blur 提交）', (await win.locator('.explorer .rename-input').count()) === 0)

  // ---- 编辑器：打开 b.txt，改成 bye-local 保存，磁盘校验 ----
  await win.locator('.explorer .row', { hasText: 'b.txt' }).first().dblclick()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  await win.waitForTimeout(600)
  const cmText = (await win.locator('.cm-content').textContent()) ?? ''
  check('编辑器读出内容', cmText.includes('hello-local'), cmText.slice(0, 40))
  await win.locator('.cm-content').click()
  // CodeMirror 的 Mod 在 macOS 是 ⌘(Meta)、其余平台是 Ctrl；Windows 上 Meta 是 Win 键
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.type('bye-local')
  await win.keyboard.press(`${mod}+s`)
  await win.waitForTimeout(800)
  check('编辑器保存落盘', fs.readFileSync(path.join(base, 'b.txt'), 'utf8') === 'bye-local')

  // ---- 在终端打开此目录 ----
  await win.locator('.explorer button[title="在终端中打开此目录"]').click()
  await win.waitForTimeout(1200)
  const termText = await win.evaluate(
    () => document.querySelector('.tab-content:not([style*="display: none"]) .xterm-rows')?.textContent ?? ''
  )
  check('终端收到 cd 到测试目录', termText.includes('dox-e2e-local'), termText.slice(-60))

  // ---- 本机复制：enqueueDropped（复制进 copydst）----
  await win.evaluate(
    ([src, dst]) =>
      window.api.enqueueDropped('local-verify', dst, [{ path: src, name: 'b.txt', size: 9 }]),
    [path.join(base, 'b.txt'), path.join(base, 'copydst')]
  )
  let copied = false
  for (let i = 0; i < 20; i++) {
    await win.waitForTimeout(500)
    if (fs.existsSync(path.join(base, 'copydst', 'b.txt'))) { copied = true; break }
  }
  check('本机复制落盘', copied && fs.readFileSync(path.join(base, 'copydst', 'b.txt'), 'utf8') === 'bye-local')
  const tasks = await win.evaluate(() => window.api.listTransfers())
  check('复制任务进队列且完成', tasks.some((t) => t.status === 'done' && t.remotePath.includes('copydst')))

  // ---- 打包（系统 tar）：b.txt → b.txt.tar.gz ----
  await win.locator('.explorer .row', { hasText: 'b.txt' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '打包' }).click()
  let archived = false
  for (let i = 0; i < 20; i++) {
    await win.waitForTimeout(500)
    if (fs.existsSync(path.join(base, 'b.txt.tar.gz'))) { archived = true; break }
  }
  check('打包落盘（系统 tar）', archived)

  // ---- 键盘快捷键：Cmd/Ctrl+A 全选、F 过滤、C/V 复制粘贴 ----
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control'
  await win.locator('.explorer .row', { hasText: 'b.txt' }).first().click()
  await win.keyboard.press(`${modKey}+a`)
  const totalRows = await win.locator('.explorer .row').count()
  const selectedRows = await win.locator('.explorer .row.selected').count()
  check('Cmd/Ctrl+A 全选', totalRows > 1 && selectedRows === totalRows, `${selectedRows}/${totalRows}`)

  await win.keyboard.press(`${modKey}+f`)
  await win.waitForTimeout(300)
  check(
    '过滤框出现并聚焦',
    await win.evaluate(() => document.activeElement?.classList.contains('filter-input'))
  )
  await win.keyboard.type('b.tx')
  await win.waitForTimeout(400)
  const filteredNames = await win.evaluate(() =>
    [...document.querySelectorAll('.explorer .file-list .row .file-name')].map((e) => e.textContent.trim())
  )
  check(
    'Cmd/Ctrl+F 过滤只显示匹配行',
    filteredNames.length > 0 && filteredNames.every((n) => n.includes('b.tx')),
    JSON.stringify(filteredNames)
  )
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  check(
    'Esc 关闭过滤恢复全量',
    (await win.locator('.explorer .filter-input').count()) === 0 &&
      (await win.locator('.explorer .row').count()) === totalRows
  )

  // C/V：复制 b.txt，进 sub 粘贴（本机走传输队列），落盘校验后退回根目录
  await win.locator('.explorer .row', { hasText: 'b.txt' }).first().click()
  await win.keyboard.press(`${modKey}+c`)
  await win.locator('.explorer .row', { hasText: 'sub' }).first().dblclick()
  await win.waitForTimeout(800)
  await win.keyboard.press(`${modKey}+v`)
  let kbCopied = false
  for (let i = 0; i < 20; i++) {
    await win.waitForTimeout(500)
    if (fs.existsSync(path.join(base, 'sub', 'b.txt'))) { kbCopied = true; break }
  }
  check(
    'Cmd/Ctrl+C → V 粘贴落盘（本机走传输队列）',
    kbCopied && fs.readFileSync(path.join(base, 'sub', 'b.txt'), 'utf8') === 'bye-local'
  )
  await win.locator('.explorer button[title="后退（鼠标侧键）"]').click()
  await win.waitForTimeout(800)

  // ---- 删除（右键 made → 删除，dialog 自动确认）----
  await win.locator('.explorer .row', { hasText: 'made' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '删除' }).click()
  await win.waitForTimeout(800)
  check('删除落盘', !fs.existsSync(path.join(base, 'made')))

  // ---- 目录历史：进 sub → 后退回来 ----
  await win.locator('.explorer .row', { hasText: 'sub' }).first().dblclick()
  await win.waitForTimeout(1000)
  check('进入 sub', ((await win.locator('.explorer .breadcrumb').textContent()) ?? '').includes('sub'))
  await win.locator('.explorer button[title="后退（鼠标侧键）"]').click()
  await win.waitForTimeout(1000)
  const crumbBack = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('后退回测试目录', crumbBack.includes('dox-e2e-local') && !crumbBack.includes('sub'), crumbBack)

  // ---- 磁盘用量条（本机 statfs，POSIX 必有；Windows 没有就藏）----
  if (process.platform !== 'win32') {
    check('磁盘用量条出现', await win.locator('.explorer .usage-bar').count() === 1)
  }

  await win.screenshot({ path: 'shots/97-local-explorer.png' })
} finally {
  // 先关应用再清目录：「在终端打开此目录」把本机终端的 cwd 落进了测试目录，
  // Windows 不允许删除任何进程的 cwd（EPERM）；关应用后 pty 退出才解锁
  await win.evaluate(() => window.api.setLayout({ tabs: [] })).catch(() => undefined)
  if (origSettings) await win.evaluate((s) => window.api.setSettings(s), origSettings).catch(() => undefined)
  await app.close().catch(() => undefined)
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(base, { recursive: true, force: true })
      break
    } catch (err) {
      if (i === 9) throw err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

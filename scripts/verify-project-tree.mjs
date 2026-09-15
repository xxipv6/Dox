/**
 * 文件面板「项目模式」（树形视图）端到端：
 *  browse 回归 → 右键「进入项目模式」→ 懒加载 → 展开缓存（零往返）→
 *  双击开编辑器 → 键盘导航 → 跟随终端 reveal → 退出回到原目录 →
 *  持久化恢复（reload 后直接回项目模式）→ DOM 契约。
 *
 * 用法：node scripts/verify-project-tree.mjs
 * 前置：npm run build。测试目录在 $HOME/dox-e2e-tree，结束自清理（含 settings.projectRoots）。
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

// ---- 磁盘夹具：$HOME/dox-e2e-tree/{a.txt, b.txt, sub/deep/c.txt} ----
const base = path.join(os.homedir(), 'dox-e2e-tree')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(path.join(base, 'sub', 'deep'), { recursive: true })
fs.writeFileSync(path.join(base, 'a.txt'), 'aaa')
fs.writeFileSync(path.join(base, 'b.txt'), 'bbb')
fs.writeFileSync(path.join(base, 'sub', 'deep', 'c.txt'), 'ccc')

// 僵尸实例会占住单实例锁（exit 0 假启动）与布局文件
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
// 收尾要恢复的原始设置（projectRoots 会被本脚本改动）
const origSettings = await win.evaluate(() => window.api.getSettings())
// 清项目根记忆 + 清布局，从干净状态开始
await win.evaluate(async (s) => {
  await window.api.setSettings({ ...s, projectRoots: {} })
  await window.api.setLayout({ tabs: [] })
  location.reload()
}, origSettings)
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const rowWith = (sel, text) =>
  win.locator(sel).filter({ has: win.locator(`.file-name:text-is("${text}")`) }).first()

try {
  // ---- 开面板（本地终端标签，家目录）----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .file-list .row').first().waitFor({ timeout: 10000 })

  // ---- 1. browse 回归：现有结构一个不能少 ----
  check('browse：面包屑在', await win.locator('.explorer .breadcrumb').count() === 1)
  check('browse：文件列表在', await win.locator('.explorer .file-list').count() === 1)

  // ---- 2. 右键进入项目模式 ----
  await rowWith('.explorer .file-list .row', 'dox-e2e-tree').click({ button: 'right' })
  const enterItem = win.locator('.context-menu .menu-item', { hasText: '进入项目模式' })
  check('右键菜单含「进入项目模式」', (await enterItem.count()) === 1)
  await enterItem.click()
  await win.locator('.explorer .project-bar').waitFor({ timeout: 5000 })
  check('项目顶栏出现且含根名',
    ((await win.locator('.explorer .project-bar').textContent()) ?? '').includes('dox-e2e-tree'))
  check('browse 区块全部消失',
    (await win.locator('.explorer .file-list').count()) === 0 &&
    (await win.locator('.explorer .breadcrumb').count() === 0))
  await win.locator('.explorer .tree .tree-row').first().waitFor({ timeout: 10000 })
  check('树根行渲染', (await win.locator('.explorer .tree .tree-row').count()) > 0)

  // ---- 3. 懒加载：初始只有根的直接子级 ----
  await rowWith('.explorer .tree .tree-row', 'a.txt').waitFor({ timeout: 5000 })
  check('懒加载：直接子级可见',
    (await rowWith('.explorer .tree .tree-row', 'a.txt').count()) === 1 &&
    (await rowWith('.explorer .tree .tree-row', 'sub').count()) === 1)
  check('懒加载：未展开的深层不出现',
    (await rowWith('.explorer .tree .tree-row', 'deep').count()) === 0 &&
    (await rowWith('.explorer .tree .tree-row', 'c.txt').count()) === 0)

  // ---- 4. 展开 sub → deep 出现；折叠再展开 = 零往返（缓存）----
  await rowWith('.explorer .tree .tree-row', 'sub').locator('.tree-chevron').click()
  await rowWith('.explorer .tree .tree-row', 'deep').waitFor({ timeout: 5000 })
  check('展开 sub 出 deep', (await rowWith('.explorer .tree .tree-row', 'deep').count()) === 1)
  check('chevron 展开态类名',
    (await rowWith('.explorer .tree .tree-row', 'sub').locator('.tree-chevron.expanded').count()) === 1)
  // 折叠 → 再展开，50ms 内回来（网络往返没这么快，回来即证明走了缓存）
  await rowWith('.explorer .tree .tree-row', 'sub').locator('.tree-chevron').click()
  await win.waitForTimeout(300)
  check('折叠后 deep 消失', (await rowWith('.explorer .tree .tree-row', 'deep').count()) === 0)
  await rowWith('.explorer .tree .tree-row', 'sub').locator('.tree-chevron').click()
  await win.waitForTimeout(50)
  check('再展开走缓存（50ms 内回来）',
    (await rowWith('.explorer .tree .tree-row', 'deep').count()) === 1)

  // ---- 5. 展开 deep，双击 c.txt → 编辑器打开 ----
  await rowWith('.explorer .tree .tree-row', 'deep').locator('.tree-chevron').click()
  await rowWith('.explorer .tree .tree-row', 'c.txt').waitFor({ timeout: 5000 })
  await rowWith('.explorer .tree .tree-row', 'c.txt').dblclick()
  await win.locator('.editor-panel .etab').first().waitFor({ timeout: 10000 })
  check('双击文件打开编辑器', (await win.locator('.editor-panel .etab').count()) > 0)

  // ---- 6. 键盘导航（当前：sub/deep 展开，c.txt 选中）----
  await win.locator('.explorer .tree').focus()
  await win.keyboard.press('ArrowUp')
  await win.waitForTimeout(200)
  check('↑ 移到 deep',
    ((await win.locator('.explorer .tree .tree-row.selected').textContent()) ?? '').includes('deep'))
  await win.keyboard.press('ArrowLeft') // deep 已展开 → 折叠
  await win.waitForTimeout(200)
  check('← 折叠 deep（c.txt 消失）',
    (await rowWith('.explorer .tree .tree-row', 'c.txt').count()) === 0)
  await win.keyboard.press('ArrowLeft') // deep 未展开 → 跳父
  await win.waitForTimeout(200)
  check('← 跳到父级 sub',
    ((await win.locator('.explorer .tree .tree-row.selected').textContent()) ?? '').includes('sub'))
  await win.keyboard.press('ArrowLeft') // sub 已展开 → 折叠
  await win.waitForTimeout(200)
  await win.keyboard.press('ArrowRight') // sub 折叠 → 展开（缓存）
  await win.waitForTimeout(200)
  check('→ 展开 sub（deep 回来）',
    (await rowWith('.explorer .tree .tree-row', 'deep').count()) === 1)
  await win.keyboard.press('ArrowRight') // 已展开 → 进第一个子行
  await win.waitForTimeout(200)
  check('→ 进入首子行 deep',
    ((await win.locator('.explorer .tree .tree-row.selected').textContent()) ?? '').includes('deep'))

  // ---- 7. 跟随终端 reveal：终端 cd 进 sub/deep → 链自动展开且选中 deep ----
  // （reveal 语义 = 展开**祖先**链并选中目标，与 VS Code reveal 一致；
  //   目标目录自身不展开 —— 所以这里不断言 c.txt 出现）
  const followBtn = win.locator('.explorer button[title^="跟随终端"]')
  if (((await followBtn.getAttribute('title')) ?? '').includes('关')) await followBtn.click()
  // deep 现在是折叠/选中态；先点别的行让 reveal 的效果可分辨
  await rowWith('.explorer .tree .tree-row', 'a.txt').click()
  await win.locator('.tab-content:visible .xterm-helper-textarea').first().click()
  await win.keyboard.type(`cd "${path.join(base, 'sub', 'deep')}"`)
  await win.keyboard.press('Enter')
  let revealed = false
  for (let i = 0; i < 10; i++) {
    await win.waitForTimeout(500)
    const sel = (await win.locator('.explorer .tree .tree-row.selected').textContent()) ?? ''
    if (sel.includes('deep')) { revealed = true; break }
  }
  check('跟随终端 reveal：链自动展开且选中 deep', revealed)

  // ---- 8. 退出项目模式：回到进入前的目录（家目录） ----
  await win.locator('.explorer .project-bar button[title="退出项目模式"]').click()
  await win.locator('.explorer .file-list .row').first().waitFor({ timeout: 10000 })
  check('退出后面包屑回来', await win.locator('.explorer .breadcrumb').count() === 1)
  check('退出后停在进入前的目录（家目录）',
    (await rowWith('.explorer .file-list .row', 'dox-e2e-tree').count()) === 1)

  // ---- 9. 持久化恢复：再进一次 → reload → 直接回项目模式 ----
  await rowWith('.explorer .file-list .row', 'dox-e2e-tree').click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '进入项目模式' }).click()
  await win.locator('.explorer .project-bar').waitFor({ timeout: 5000 })
  await win.waitForTimeout(500) // 等 settings 落盘
  await win.evaluate(() => location.reload())
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  let restored = false
  for (let i = 0; i < 10; i++) {
    await win.waitForTimeout(500)
    const bar = (await win.locator('.explorer .project-bar').textContent().catch(() => '')) ?? ''
    if (bar.includes('dox-e2e-tree')) { restored = true; break }
  }
  check('reload 后直接恢复项目模式', restored)

  // ---- 10. DOM 契约（给后续脚本/样式锚定用；恢复后是全新折叠态，先展开 sub）----
  await rowWith('.explorer .tree .tree-row', 'sub').locator('.tree-chevron').click()
  await rowWith('.explorer .tree .tree-row', 'deep').waitFor({ timeout: 5000 })
  check('data-path 属性', (await win.locator('.explorer .tree .tree-row[data-path]').count()) > 0)
  check('参考线 .guide（深层行）', (await win.locator('.explorer .tree .guide').count()) > 0)
  check('chevron 展开态（恢复后再次展开）',
    (await rowWith('.explorer .tree .tree-row', 'sub').locator('.tree-chevron.expanded').count()) === 1)

  await win.screenshot({ path: 'shots/project-tree.png' })
} catch (err) {
  console.log('  FAIL 异常中断', err)
  failed = true
  try {
    await win.screenshot({ path: 'shots/project-tree-fail.png' })
  } catch { /* 截图也失败就算了 */ }
} finally {
  // 卫生：恢复设置（这是真实用户配置），清夹具
  try {
    if (origSettings) {
      await win.evaluate((s) => window.api.setSettings({ ...s, projectRoots: {} }), origSettings)
    }
  } catch { /* 实例可能已死 */ }
  await app.close().catch(() => undefined)
  fs.rmSync(base, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

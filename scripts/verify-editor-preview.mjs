/**
 * 编辑器「预览标签 + 底部状态栏」端到端：
 *  树单击预览（斜体）→ 预览替换（标签数不变）→ 双击转正 → 编辑即转正 →
 *  切 tab 预览态保持 → 状态栏（行:列 / EOL / 大小 / 修改时间）→
 *  browse 双击固定回归 → dirty 大小实时变化。
 *
 * 用法：node scripts/verify-editor-preview.mjs
 * 前置：npm run build。测试目录在 $HOME/dox-e2e-preview，结束自清理（含 settings.projectRoots）。
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

// ---- 磁盘夹具：$HOME/dox-e2e-preview/{a.txt, b.txt, crlf.txt} ----
const base = path.join(os.homedir(), 'dox-e2e-preview')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })
fs.writeFileSync(path.join(base, 'a.txt'), 'alpha\nbeta\n')
fs.writeFileSync(path.join(base, 'b.txt'), 'bravo\nhttps://example.com/doc\n')
// CRLF 夹具：验证状态栏 EOL 判定（Buffer 写二进制，绕过 git 换行归一化的心智负担）
fs.writeFileSync(path.join(base, 'crlf.txt'), Buffer.from('charlie\r\ndelta\r\n', 'utf8'))

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

const etabWith = (text) =>
  win.locator('.editor-panel .etab').filter({ has: win.locator(`.etab-name:text-is("${text}")`) }).first()

const statusText = async () =>
  ((await win.locator('.editor-panel .editor-status').textContent().catch(() => '')) ?? '').trim()

/** 状态栏各字段（span 间是 CSS gap，textContent 无分隔符 —— 按 span 逐个断言才准） */
const statusParts = async () => {
  const spans = await win.locator('.editor-panel .editor-status > span').allTextContents().catch(() => [])
  return spans.map((s) => s.trim()).filter(Boolean)
}

/** 等编辑器真正挂好（读完后）再读状态栏，loading 态没有它 */
const waitEditorReady = async () => {
  await win.locator('.editor-panel .editor-host .cm-editor').waitFor({ timeout: 10000 })
  await win.waitForTimeout(200)
}

try {
  // ---- 开面板 + 进项目模式（右键夹具目录）----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .file-list .row').first().waitFor({ timeout: 10000 })
  await rowWith('.explorer .file-list .row', 'dox-e2e-preview').click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '进入项目模式' }).click()
  await win.locator('.explorer .project-bar').waitFor({ timeout: 5000 })
  await win.locator('.explorer .tree .tree-row').first().waitFor({ timeout: 10000 })

  // ---- 1. 树单击 a.txt → 预览打开（斜体标签）----
  await rowWith('.explorer .tree .tree-row', 'a.txt').click()
  await win.locator('.editor-panel .etab').first().waitFor({ timeout: 10000 })
  await win.locator('.editor-panel .editor-host .cm-editor').waitFor({ timeout: 10000 })
  check('单击文件打开编辑器', (await win.locator('.editor-panel .etab').count()) === 1)
  check('预览标签斜体（.etab.preview）',
    (await win.locator('.editor-panel .etab.preview .etab-name').count()) === 1)

  // ---- 2. 状态栏基础断言（alpha\nbeta\n = 11 字节）----
  await waitEditorReady()
  const p1 = await statusParts()
  check('状态栏：行:列（初始 1:1）', p1.includes('1:1'), p1.join('|'))
  check('状态栏：UTF-8', p1.includes('UTF-8'), p1.join('|'))
  check('状态栏：LF', p1.includes('LF'), p1.join('|'))
  check('状态栏：大小（11 字节）', p1.includes('11 B'), p1.join('|'))
  check('状态栏：修改时间', p1.some((s) => s.startsWith('修改于')), p1.join('|'))

  // ---- 3. 光标移动 → 行:列实时变 ----
  await win.locator('.editor-panel .editor-host .cm-content').click({ position: { x: 10, y: 10 } })
  await win.keyboard.press('ArrowDown')
  await win.keyboard.press('End')
  await win.waitForTimeout(200)
  const p2 = await statusParts()
  check('状态栏：光标移动后行:列变化（第 2 行）', p2.some((s) => /^2:\d+$/.test(s)), p2.join('|'))

  // ---- 4. 预览替换：单击 b.txt → 标签数不变、还是斜体 ----
  await rowWith('.explorer .tree .tree-row', 'b.txt').click()
  await etabWith('b.txt').waitFor({ timeout: 10000 })
  check('预览替换：标签数不变（1）', (await win.locator('.editor-panel .etab').count()) === 1)
  check('预览替换：新标签仍是预览（斜体）',
    (await win.locator('.editor-panel .etab.preview .etab-name').count()) === 1)

  // ---- 5. 双击 b.txt → 转正（斜体消失，标签数不变）----
  await rowWith('.explorer .tree .tree-row', 'b.txt').dblclick()
  await win.waitForTimeout(500)
  check('双击转正：斜体消失',
    (await win.locator('.editor-panel .etab.preview').count()) === 0)
  check('双击转正：标签数仍 1（不重复开）', (await win.locator('.editor-panel .etab').count()) === 1)

  // ---- 6. 再单击 a.txt → 新预览标签追加（b.txt 已固定不被顶）----
  await rowWith('.explorer .tree .tree-row', 'a.txt').click()
  await etabWith('a.txt').waitFor({ timeout: 10000 })
  check('固定标签不被预览顶掉（2 个标签）',
    (await win.locator('.editor-panel .etab').count()) === 2)
  check('a.txt 处于预览态（斜体）',
    (await etabWith('a.txt').locator('.etab-name').evaluate((el) => getComputedStyle(el).fontStyle)) === 'italic')
  check('b.txt 保持固定（不斜体）',
    (await etabWith('b.txt').locator('.etab-name').evaluate((el) => getComputedStyle(el).fontStyle)) === 'normal')

  // ---- 7. 编辑即转正：在预览中的 a.txt 打字 ----
  await win.locator('.editor-panel .editor-host .cm-content').click({ position: { x: 10, y: 10 } })
  await win.keyboard.press('End')
  await win.keyboard.type('X')
  await win.waitForTimeout(300)
  check('编辑即转正：斜体消失',
    (await win.locator('.editor-panel .etab.preview').count()) === 0)
  // dirty 态：大小应变为当前内容字节数（alphaX\nbeta\n = 12 字节）
  const p3 = await statusParts()
  check('dirty 态大小实时变化（12 B）', p3.includes('12 B'), p3.join('|'))

  // ---- 8. 切 tab 再切回：光标恢复、预览态不因切换丢失（先造一个预览）----
  await rowWith('.explorer .tree .tree-row', 'crlf.txt').click()
  await etabWith('crlf.txt').waitFor({ timeout: 10000 })
  await waitEditorReady()
  check('CRLF 文件状态栏显示 CRLF', (await statusParts()).includes('CRLF'))
  // crlf.txt 现在是预览、active；切到 b.txt 再切回 crlf.txt
  await etabWith('b.txt').click()
  await win.waitForTimeout(200)
  await etabWith('crlf.txt').click()
  await win.waitForTimeout(200)
  check('切 tab 后预览态保持（斜体还在）',
    (await etabWith('crlf.txt').locator('.etab-name').evaluate((el) => getComputedStyle(el).fontStyle)) === 'italic')
  check('切 tab 后状态栏恢复 CRLF', (await statusParts()).includes('CRLF'))

  // ---- 9. URL 悬停：Meta 按住扫过 URL 行出现下划线标记，松开消失 ----
  // （不真点击 —— domEventHandlers 的 Cmd+点击会 openExternal 起系统浏览器）
  await etabWith('b.txt').click()
  await waitEditorReady()
  await win.keyboard.down('Meta')
  const content = win.locator('.editor-panel .cm-content')
  const box = await content.boundingBox()
  let underlined = false
  for (let y = 10; y <= 70 && !underlined; y += 6) {
    await win.mouse.move(box.x + 160, box.y + y)
    await win.waitForTimeout(60)
    underlined = (await win.locator('.editor-panel .cm-url').count()) > 0
  }
  check('URL 悬停：修饰键按下出现下划线（.cm-url）', underlined)
  await win.keyboard.up('Meta')
  await win.waitForTimeout(150)
  check('URL 悬停：松开修饰键下划线消失',
    (await win.locator('.editor-panel .cm-url').count()) === 0)

  await win.screenshot({ path: 'shots/editor-preview.png' })
} catch (err) {
  console.log('  FAIL 异常中断', err)
  failed = true
  try {
    await win.screenshot({ path: 'shots/editor-preview-fail.png' })
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

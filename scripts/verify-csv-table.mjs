/**
 * 编辑器「CSV/TSV 表格视图」端到端：
 *  默认表格（行号 + A/B/C 列标）→ 解析边界（BOM/引号内逗号换行/列不齐/中间空行/字面引号）
 *  → tsv 按 Tab → 表格↔文本来回切（撤销历史保住 = M1 回归守卫）→ dirty 带进表格态保存仍可用
 *  → 2000 行渲染截断 + 尾注 → 状态栏 N 行 × M 列 → 空文件 → 预览正交。
 *
 * 手测清单项（脚本不覆盖）：搜索结果点 csv → 自动切文本并跳行（revealLine 链路要真实搜索面板）。
 *
 * 用法：node scripts/verify-csv-table.mjs
 * 前置：npm run build。测试目录在 $HOME/dox-e2e-csv，结束自清理（含 settings.projectRoots）。
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

// ---- 磁盘夹具 ----
const base = path.join(os.homedir(), 'dox-e2e-csv')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })
fs.writeFileSync(path.join(base, 'plain.csv'), '1,2,3\n4,5,6\n7,8,9\n')
// 解析边界全家桶：BOM、引号内逗号/换行、CRLF、列不齐、中间空行、字段中段引号
fs.writeFileSync(
  path.join(base, 'q.csv'),
  Buffer.from(
    '﻿a,b,c,d\r\n' +
      '"x,y",plain,,4\n' +
      '"two\nlines","z"\n' +
      '\n' +
      'weird"q,end\n',
    'utf8'
  )
)
fs.writeFileSync(path.join(base, 'data.tsv'), 'a\tb\tc\n1\t2\t3\n')
// 链接格：整格 URL 才算；URL 混在文本里不算
fs.writeFileSync(
  path.join(base, 'links.csv'),
  'name,link\nsite,https://example.com/doc\nmixed,see https://example.com/x\n'
)
fs.writeFileSync(path.join(base, 'empty.csv'), '')
const big = ['h1,h2,h3']
for (let i = 1; i < 2500; i++) big.push(`${i},row ${i},tail`)
fs.writeFileSync(path.join(base, 'big.csv'), big.join('\n') + '\n')

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
const origSettings = await win.evaluate(() => window.api.getSettings())
await win.evaluate(async (s) => {
  await window.api.setSettings({ ...s, projectRoots: {} })
  await window.api.setLayout({ tabs: [] })
  location.reload()
}, origSettings)
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const consoleErrors = []
win.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})

const rowWith = (sel, text) =>
  win.locator(sel).filter({ has: win.locator(`.file-name:text-is("${text}")`) }).first()
const cellAt = (r, c) => win.locator(`.editor-panel .csv-table tbody tr:nth-child(${r}) td.cell:nth-child(${c + 1})`)
const rowCells = (r) => win.locator(`.editor-panel .csv-table tbody tr:nth-child(${r}) td.cell`)
const rowNum = (r) => win.locator(`.editor-panel .csv-table tbody tr:nth-child(${r}) td.row-num`)
const statusParts = async () => {
  const spans = await win.locator('.editor-panel .editor-status > span').allTextContents().catch(() => [])
  return spans.map((s) => s.trim()).filter(Boolean)
}
/** CodeMirror 当前内容（.cm-line 拼回） */
const editorText = async () =>
  win.locator('.editor-panel .cm-content .cm-line').allTextContents().then((ls) => ls.join('\n'))
const viewToggle = () => win.locator('.editor-panel .bar-btn', { hasText: /^(表格|文本)$/ })
const waitTable = () => win.locator('.editor-panel .csv-table').waitFor({ timeout: 10000 })
const waitEditor = () => win.locator('.editor-panel .cm-editor').waitFor({ timeout: 10000 })

try {
  // ---- 开面板 + 进项目模式 ----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .file-list .row').first().waitFor({ timeout: 10000 })
  await rowWith('.explorer .file-list .row', 'dox-e2e-csv').click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '进入项目模式' }).click()
  await win.locator('.explorer .project-bar').waitFor({ timeout: 5000 })
  await win.locator('.explorer .tree .tree-row').first().waitFor({ timeout: 10000 })

  // ---- 1. plain.csv：默认表格视图 ----
  await rowWith('.explorer .tree .tree-row', 'plain.csv').dblclick()
  await waitTable()
  check('默认表格：.csv-table 在', true)
  check('默认表格：CodeMirror 不在', (await win.locator('.editor-panel .cm-editor').count()) === 0)
  check('角格存在', (await win.locator('.editor-panel .csv-table thead .corner').count()) === 1)
  const heads = await win.locator('.editor-panel .csv-table thead th.col-head').allTextContents()
  check('列标 A/B/C', heads.join(',') === 'A,B,C', heads.join(','))
  check('行号 1/2/3', (await rowNum(1).textContent()) === '1' && (await rowNum(3).textContent()) === '3')
  check('单元格内容', (await cellAt(1, 1).textContent()) === '1')

  // ---- 2. q.csv：解析边界 ----
  await rowWith('.explorer .tree .tree-row', 'q.csv').dblclick()
  await waitTable()
  await win.waitForTimeout(300)
  const qHeads = await win.locator('.editor-panel .csv-table thead th.col-head').allTextContents()
  check('q：最大列数 4（A..D）', qHeads.length === 4, qHeads.join(','))
  check('q：BOM 剥除（首格是 a）', (await cellAt(1, 1).textContent()) === 'a')
  check('q：引号内逗号是一格', (await cellAt(2, 1).textContent()) === 'x,y')
  check('q：引号内换行是一格', (await cellAt(3, 1).textContent()) === 'two\nlines')
  check('q：短行补齐到 4 列', (await rowCells(3).count()) === 4)
  check('q：补齐格为空', (await cellAt(3, 3).textContent()) === '')
  check('q：中间空行占一行（行号连续）', (await rowNum(4).textContent()) === '4')
  check('q：字段中段引号字面', (await cellAt(5, 1).textContent()) === 'weird"q')
  check('q：共 5 条记录', (await win.locator('.editor-panel .csv-table tbody tr').count()) === 5)

  // ---- 3. tsv：按 Tab 拆 ----
  await rowWith('.explorer .tree .tree-row', 'data.tsv').dblclick()
  await waitTable()
  const tHeads = await win.locator('.editor-panel .csv-table thead th.col-head').allTextContents()
  check('tsv：按 Tab 拆 3 列', tHeads.length === 3, tHeads.join(','))
  check('tsv：单元格内容', (await cellAt(2, 2).textContent()) === '2')

  // ---- 4. 表格↔文本：内容一致 + 撤销历史往返 + dirty 带进表格态 ----
  const tsvDisk = fs.readFileSync(path.join(base, 'data.tsv'), 'utf8')
  await viewToggle().click() // 「文本」
  await waitEditor()
  const textBefore = await editorText()
  // CM 把尾换行渲染成一个空行，拼回来的串与磁盘原文件逐字节一致（含尾换行）
  check('切文本：内容与原文一致', textBefore === tsvDisk, JSON.stringify(textBefore))

  // 文本态打字 → dirty；带进表格态验证保存可用（M2），再切回来 Undo 还原（M1）
  await win.locator('.editor-panel .cm-content').click({ position: { x: 10, y: 10 } })
  await win.keyboard.press('End')
  await win.keyboard.type('Q')
  await win.waitForTimeout(200)
  check('文本态编辑 → dirty', (await win.locator('.editor-panel .etab .dirty-dot').count()) === 1)
  await viewToggle().click() // 「表格」
  await waitTable()
  const saveBtn = win.locator('.editor-panel .bar-btn', { hasText: '保存' })
  check('dirty 带进表格态：保存仍可用', await saveBtn.isEnabled())
  await viewToggle().click() // 「文本」
  await waitEditor()
  await win.locator('.editor-panel .cm-content').click({ position: { x: 10, y: 10 } })
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await win.waitForTimeout(200)
  check('撤销历史在表格往返后保住（M1）', (await editorText()) === textBefore)
  check('撤销后 dirty 消失', (await win.locator('.editor-panel .etab .dirty-dot').count()) === 0)

  // ---- 5. big.csv：2000 行截断 + 尾注 + 状态栏 ----
  await rowWith('.explorer .tree .tree-row', 'big.csv').dblclick()
  await waitTable()
  check('big：渲染截断到 2000 行', (await win.locator('.editor-panel .csv-table tbody tr').count()) === 2000)
  const note = (await win.locator('.editor-panel .csv-note').textContent().catch(() => '')) ?? ''
  check('big：尾注含总行数', note.includes('共 2500 行'), note)
  const bigParts = await statusParts()
  check('big：状态栏 N 行 × M 列', bigParts.some((s) => /^2500 行 × 3 列$/.test(s)), bigParts.join('|'))
  check('big：表格态无 行:列 段', !bigParts.some((s) => /^\d+:\d+$/.test(s)), bigParts.join('|'))
  await win.screenshot({ path: 'shots/csv-table.png' })

  // ---- 6. empty.csv：空文件不炸 ----
  await rowWith('.explorer .tree .tree-row', 'empty.csv').dblclick()
  await waitTable()
  check('empty：0 数据行渲染正常', (await win.locator('.editor-panel .csv-table tbody tr').count()) === 0)
  const eParts = await statusParts()
  check('empty：状态栏 0 行 × 0 列', eParts.some((s) => s.includes('0 行 × 0 列')), eParts.join('|'))

  // ---- 7. 链接格：整格 URL 标记 + 修饰键显形（点击走 openExternal，与编辑器同通道，不真点）----
  await rowWith('.explorer .tree .tree-row', 'links.csv').dblclick()
  await waitTable()
  await win.waitForTimeout(300)
  check('链接：整格 URL 标记为 .url', (await win.locator('.editor-panel .csv-table td.cell.url').count()) === 1)
  check(
    '链接：URL 混在文本里不算',
    !(await win.locator('.editor-panel .csv-table td.cell.url', { hasText: 'see ' }).count())
  )
  await win.keyboard.down('Meta')
  await win.waitForTimeout(150)
  check('链接：修饰键按下容器 .mod-held', (await win.locator('.editor-panel .csv-host.mod-held').count()) === 1)
  const urlCursor = await win
    .locator('.editor-panel .csv-table td.cell.url')
    .evaluate((el) => getComputedStyle(el).cursor)
  check('链接：修饰键下链接格手型', urlCursor === 'pointer', urlCursor)
  await win.keyboard.up('Meta')
  await win.waitForTimeout(150)
  check('链接：松开修饰键显形消失', (await win.locator('.editor-panel .csv-host.mod-held').count()) === 0)

  // ---- 8. 预览正交：单击 csv → 斜体预览 + 表格正常；文本态编辑即转正 ----
  await rowWith('.explorer .tree .tree-row', 'plain.csv').click()
  await waitTable()
  await win.waitForTimeout(300)
  check('单击 csv：预览标签（斜体）', (await win.locator('.editor-panel .etab.preview').count()) === 1)
  check('单击 csv：表格照常渲染', (await win.locator('.editor-panel .csv-table tbody tr').count()) === 3)
  await viewToggle().click() // 「文本」
  await waitEditor()
  await win.locator('.editor-panel .cm-content').click({ position: { x: 10, y: 10 } })
  await win.keyboard.type('X')
  await win.waitForTimeout(200)
  check('文本态编辑：预览转正（斜体消失）', (await win.locator('.editor-panel .etab.preview').count()) === 0)
  // 收尾：撤销掉测试输入，避免 dirty 卡着后续（关标签有确认框）
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')

  await win.screenshot({ path: 'shots/csv-text.png' })
  check('渲染进程无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (err) {
  console.log('  FAIL 异常中断', err)
  failed = true
  try {
    await win.screenshot({ path: 'shots/csv-table-fail.png' })
  } catch { /* 截图也失败就算了 */ }
} finally {
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

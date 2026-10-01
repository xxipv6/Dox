/**
 * 编辑器撤销历史回归：改文件 → 切标签 → 切回来 → ⌘Z 应还能撤销。
 * （FileEditor 按 ed-<sessionId> 作 key，切标签重挂载，cachedStates 曾随之蒸发）
 *
 * 用法：node scripts/verify-editor-undo-restore.mjs
 * 前置：npm run build。隔离 userData，不碰已安装的 Dox.app。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.on('unhandledRejection', () => {})

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const base = path.join(os.homedir(), 'dox-e2e-undo')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })
fs.writeFileSync(path.join(base, 'note.txt'), 'hello')

const userData = '/tmp/dox-probe-editor-undo'
fs.rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const cmText = () => win.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '')

try {
  // ---- 面板打开 note.txt → 编辑器里追加 XYZ ----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.locator('.explorer .row', { hasText: 'dox-e2e-undo' }).first().dblclick()
  await win.waitForTimeout(1000)
  await win.locator('.explorer .row', { hasText: 'note.txt' }).first().dblclick()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  await win.locator('.cm-content').click()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.type('XYZhello')
  await win.waitForTimeout(400)
  check('编辑内容进编辑器', (await cmText()).includes('XYZhello'))

  // ---- 切走再切回来（编辑器重挂载）----
  await win.locator('button.tab-new').click()
  await win.waitForTimeout(1500)
  await win.locator('.tab').first().click()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  await win.waitForTimeout(600)
  check('切回来后 dirty 内容还在', (await cmText()).includes('XYZhello'))

  // ---- ⌘Z：撤销历史若随重挂载蒸发，这里什么都不会发生 ----
  await win.locator('.cm-content').click()
  await win.keyboard.press(`${mod}+z`)
  await win.waitForTimeout(400)
  const afterUndo = await cmText()
  check('切标签后 ⌘Z 仍能撤销', afterUndo.includes('hello') && !afterUndo.includes('XYZ'), afterUndo.slice(0, 40))

  await win.screenshot({ path: 'shots/99-editor-undo-restore.png' })
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

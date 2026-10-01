/**
 * 编辑器外部变更跟进回归：文件在磁盘上被改后——
 *  A. 点「重载」必须显示新内容（teardown 回存旧 state 曾让重载变死按钮）
 *  B. 关闭文件标签再打开必须显示新内容（卸载时回存+缓存未被清曾让旧内容复活）
 *  C. 文件仍开着时切应用标签，撤销历史仍保留（stateCache 的正当用途不回归）
 *
 * 用法：node scripts/verify-editor-reload.mjs
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

const base = path.join(os.homedir(), 'dox-e2e-reload')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })
const filePath = path.join(base, 'note.txt')
fs.writeFileSync(filePath, 'version-A')

const userData = '/tmp/dox-probe-editor-reload'
fs.rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const cmText = () => win.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '')
const openNote = async () => {
  await win.locator('.explorer .row', { hasText: 'note.txt' }).first().dblclick()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  await win.waitForTimeout(400)
}

try {
  // ---- 打开 note.txt（version-A）----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.locator('.explorer .row', { hasText: 'dox-e2e-reload' }).first().dblclick()
  await win.waitForTimeout(1000)
  await openNote()
  check('打开显示 version-A', (await cmText()).includes('version-A'))

  // ---- A. 磁盘改成 version-B → 点「重载」必须变 ----
  fs.writeFileSync(filePath, 'version-B')
  await win.locator('.explorer .etab, .etab', { hasText: 'note.txt' }).first().waitFor({ timeout: 5000 }).catch(() => {})
  await win.locator('button.bar-btn[title="放弃本地修改，重新从远端读取"]').click()
  await win.waitForTimeout(1200)
  check('重载显示 version-B', (await cmText()).includes('version-B'), (await cmText()).slice(0, 30))

  // ---- B. 磁盘改成 version-C → 关文件标签再开必须变 ----
  fs.writeFileSync(filePath, 'version-C')
  await win.locator('.etab-close').first().click()
  await win.waitForTimeout(800)
  await openNote()
  check('关掉再开显示 version-C', (await cmText()).includes('version-C'), (await cmText()).slice(0, 30))

  // ---- C. 文件开着切应用标签：编辑 → 切走切回 → ⌘Z 还能撤销 ----
  await win.locator('.cm-content').click()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.type('edited-C')
  await win.waitForTimeout(400)
  await win.locator('button.tab-new').click()
  await win.waitForTimeout(1500)
  await win.locator('.tab').first().click()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  await win.locator('.cm-content').click()
  await win.keyboard.press(`${mod}+z`)
  await win.waitForTimeout(400)
  const afterUndo = await cmText()
  check('切标签后 ⌘Z 仍能撤销（stateCache 不回归）',
    afterUndo.includes('version-C') && !afterUndo.includes('edited-C'), afterUndo.slice(0, 30))

  await win.screenshot({ path: 'shots/102-editor-reload.png' })
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

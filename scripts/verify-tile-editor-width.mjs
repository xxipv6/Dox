/**
 * 平铺 + 编辑器开合的宽度恢复复现探针：
 *  平铺 → 开文件（编辑器分栏，stack 收窄）→ 切标签再切回 → 关文件
 *  → stack 应恢复全宽；关掉平铺后单标签也应是全宽终端。
 *
 * 用法：node scripts/verify-tile-editor-width.mjs
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

const base = path.join(os.homedir(), 'dox-e2e-tile')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })
fs.writeFileSync(path.join(base, 'note.txt'), 'hello-tile')

const userData = '/tmp/dox-probe-tile-editor'
fs.rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const widths = () =>
  win.evaluate(() => ({
    workspace: document.querySelector('.workspace')?.clientWidth ?? -1,
    stack: document.querySelector('.terminal-stack')?.clientWidth ?? -1,
    editorOpenClass: !!document.querySelector('.terminal-area.editor-open')
  }))

/** 可见终端的渲染宽度 vs 容器宽度（fit 没跟上时渲染停在窄尺寸，右边一截空白） */
const termWidths = () =>
  win.evaluate(() => {
    const visible = [...document.querySelectorAll('.tab-content')].filter(
      (el) => !el.closest('[style*="display: none"]') && !el.style.display?.includes('none')
    )
    const out = []
    for (const tc of document.querySelectorAll('.terminal-container')) {
      const r = tc.getBoundingClientRect()
      if (r.width === 0) continue
      const screen = tc.querySelector('.xterm-screen')
      out.push({ container: Math.round(r.width), screen: Math.round(screen?.getBoundingClientRect().width ?? 0) })
    }
    return out
  })

try {
  // 第二个标签 + 平铺
  await win.locator('button.tab-new').click()
  await win.waitForTimeout(1200)
  await win.locator('button.bar-btn[title^="平铺"]').click()
  await win.waitForTimeout(800)

  // 开文件面板（基准 = 面板开着的宽度，「没点文件之前」就是这个状态）
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.locator('.explorer .row', { hasText: 'dox-e2e-tile' }).first().dblclick()
  await win.waitForTimeout(1000)
  const wBase = await widths()
  const tBase = await termWidths()
  check('基准：终端渲染占满容器', tBase.length > 0 && tBase.every((t) => t.container - t.screen < 40),
    JSON.stringify(tBase))

  // 打开 note.txt（编辑器分栏，stack 应收窄）
  await win.locator('.explorer .row', { hasText: 'note.txt' }).first().dblclick()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  await win.waitForTimeout(800)
  const w1 = await widths()
  check('编辑器打开后 stack 收窄', w1.editorOpenClass && w1.stack < wBase.stack * 0.7,
    `stack=${w1.stack}（基准 ${wBase.stack}）`)

  // 切到另一个标签再切回来（用户复现步骤）
  await win.locator('.tab').nth(0).click()
  await win.waitForTimeout(600)
  await win.locator('.tab').nth(1).click()
  await win.waitForTimeout(800)

  // 关闭文件标签（etab-close）
  await win.locator('.etab-close').first().click()
  await win.waitForTimeout(1000)
  const w2 = await widths()
  const t2 = await termWidths()
  check('关文件后 editor-open 类移除', !w2.editorOpenClass)
  check('关文件后 stack 恢复基准宽', Math.abs(w2.stack - wBase.stack) <= 2,
    `stack=${w2.stack} 基准=${wBase.stack}`)
  check('关文件后终端渲染占满容器', t2.length > 0 && t2.every((t) => t.container - t.screen < 40),
    JSON.stringify(t2))

  // 关掉平铺：单标签视图终端也应是全宽
  await win.locator('button.bar-btn[title^="正在平铺"]').click()
  await win.waitForTimeout(800)
  const t3 = await termWidths()
  check('退出平铺后终端渲染占满容器', t3.length > 0 && t3.every((t) => t.container - t.screen < 40),
    JSON.stringify(t3))

  await win.screenshot({ path: 'shots/103-tile-editor-width.png' })
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

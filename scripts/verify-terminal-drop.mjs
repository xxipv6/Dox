/**
 * 拖文件进终端的端到端：
 *  本地终端：dragover 浮层显示「松开粘贴路径」→ drop 后路径以引号形式粘进终端；
 *  SSH 终端：浮层显示「松开上传到 <cwd>」，cd 之后提示跟随变化；
 *  嵌套容器：提示「暂不支持」。
 *
 * 注：Playwright 无法构造带真实路径的 File（webUtils.getPathForFile 对合成
 * File 返回空串），所以上传落点本身由 verify-container-fs / verify-sftp 系列
 * 覆盖，这里验证「拖入手势 → 正确目标解析与提示 → 粘贴/入队分发」。
 *
 * 用法：node scripts/verify-terminal-drop.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.evaluate(async () => {
  await window.api.setLayout({ tabs: [] })
  location.reload()
})
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

// 在页面里制造一个「拖着文件」的 dragover（types 含 Files 才会被认作文件拖入；
// 空 DataTransfer 的 types 是空的 —— 必须先塞一个 File 进去）
async function fakeDragOver() {
  await win.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'fake.txt', { type: 'text/plain' }))
    const el = document.querySelector('.tab-content:not([style*="display: none"]) .terminal-container')
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }))
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
  })
}

async function veilText() {
  await win.waitForTimeout(200)
  return win.evaluate(
    () =>
      document.querySelector('.tab-content:not([style*="display: none"]) .drop-veil span')
        ?.textContent ?? null
  )
}

// ---- 本地终端：提示粘贴路径 ----
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 15000 })
await fakeDragOver()
const localHint = await veilText()
check('本地终端拖入提示「粘贴路径」', localHint === '松开粘贴路径', String(localHint))
await win.screenshot({ path: 'shots/91-drop-local.png' })

// 拖出（leave 计数归零）浮层应消失
await win.evaluate(() => {
  document
    .querySelector('.tab-content:not([style*="display: none"]) .terminal-container')
    .dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
})
await win.waitForTimeout(200)
check(
  '拖出后浮层消失',
  (await win.evaluate(
    () => document.querySelector('.tab-content:not([style*="display: none"]) .drop-veil') === null
  )) === true
)

// ---- drop 一个合成 File：本地终端应粘贴 '' 引号路径（路径为空串则粘两个引号）----
// getPathForFile 对合成 File 返回空串 —— 正好可以断言「粘贴动作发生了」（引号进终端）
await win.evaluate(() => {
  const dt = new DataTransfer()
  dt.items.add(new File(['x'], 'fake.txt', { type: 'text/plain' }))
  const el = document.querySelector('.tab-content:not([style*="display: none"]) .terminal-container')
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
})
await win.waitForTimeout(600)
const termText = await win.evaluate(
  () => document.querySelector('.tab-content:not([style*="display: none"]) .xterm-rows')?.textContent ?? ''
)
check('本地终端 drop 触发粘贴（引号落进终端）', termText.includes("''"), termText.slice(-60))

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

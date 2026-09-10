/**
 * 传输进度条 + 结束后自动消失验证。
 *
 * 用小文件验不了进度：传得太快，采样到的永远是 0 或 100。这里造一个几十兆的
 * 文件走拖拽上传（不走原生选择框，Playwright 驱动不了那个），过程中反复采样
 * 进度条宽度，确认真的是在「走」而不是一个静止的装饰；传完再确认那一条
 * 会在几秒内自己从队列里消失。
 *
 * 用法：node scripts/verify-transfer-progress.mjs
 * 前置：npm run build，且已保存一个可连接的设备
 *
 * 远端只做：写入一个测试文件、最后删掉它。不安装任何东西。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, openSync, writeSync, closeSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

mkdirSync('shots', { recursive: true })

const NAME = 'dox-progress-test.bin'
const SIZE_MB = 20
const LOCAL_DIR = join(tmpdir(), 'dox-progress-test')
rmSync(LOCAL_DIR, { recursive: true, force: true })
mkdirSync(LOCAL_DIR, { recursive: true })
const LOCAL_FILE = join(LOCAL_DIR, NAME)

// 分块写：一次性建 20MB Buffer 会白占内存
const CHUNK = Buffer.alloc(1024 * 1024, 7)
const fd = openSync(LOCAL_FILE, 'w')
for (let i = 0; i < SIZE_MB; i++) writeSync(fd, CHUNK)
closeSync(fd)

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

/** 读当前所有进度条的宽度百分比与状态文字 */
const sample = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.task')].map((t) => ({
      name: (t.querySelector('.task-name')?.textContent ?? '').trim(),
      // 用内联 style 里的 width 百分比，而不是渲染像素 —— 面板宽度会变
      width: t.querySelector('.progress-bar')?.style?.width ?? '',
      status: (t.querySelector('.task-status')?.textContent ?? '').replace(/\s+/g, ' ').trim()
    }))
  )

const rows = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.explorer .file-list .row')].map((r) =>
      (r.querySelector('.file-name')?.textContent ?? '').trim()
    )
  )

await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await win.reload()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
  undefined,
  { timeout: 15000 }
)

if (!(await win.locator('.device').count())) {
  console.log('没有已保存设备，无法验证。')
  await app.close()
  process.exit(1)
}

await win.locator('.device .device-name').first().dblclick()
await win.waitForFunction(
  () => document.querySelectorAll('.terminal-container').length >= 2,
  undefined,
  { timeout: 25000 }
)
await win.waitForTimeout(2500)
await win.locator('button:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
await win.waitForTimeout(1200)

// 起点清理：上一轮中途失败会留下同名文件
if ((await rows()).includes(NAME)) {
  const stale = win.locator('.explorer .row').filter({ hasText: NAME }).first()
  await stale.hover()
  await stale.locator('button[title="删除"]').click()
  await win.waitForTimeout(1800)
}
check('起点：远端没有该文件', !(await rows()).includes(NAME))

// ---------- 拖拽上传一个 20MB 文件 ----------
const cdp = await win.context().newCDPSession(win)
const box = await win.locator('.explorer').boundingBox()
const x = Math.round(box.x + box.width / 2)
const y = Math.round(box.y + box.height / 2)
const data = { items: [], files: [resolve(LOCAL_FILE)], dragOperationsMask: 1 }

await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
await win.waitForTimeout(200)
await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })

// ---------- 采样进度 ----------
const widths = []
let sawActive = false
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(200)
  const tasks = await sample()
  const mine = tasks.find((t) => t.name.includes(NAME))
  if (!mine) continue
  if (mine.status.startsWith('传输中')) {
    sawActive = true
    if (!widths.includes(mine.width)) widths.push(mine.width)
  }
  if (mine.status.startsWith('完成')) {
    widths.push(mine.width)
    break
  }
  if (mine.status.startsWith('失败')) break
}

console.log('采到的进度宽度序列:', JSON.stringify(widths))
check('看到了「传输中」状态', sawActive)
check(
  '进度条宽度确实在变（不是静止装饰）',
  widths.length >= 3,
  `${widths.length} 个不同取值`
)
check('最终走到 100%', widths[widths.length - 1] === '100%', widths[widths.length - 1] ?? '(无)')
await win.screenshot({ path: 'shots/33-progress.png' })

// ---------- 结束后自动消失 ----------
console.log('\n等待自动消失…')
const t0 = Date.now()
let goneAfter = null
for (let i = 0; i < 40; i++) {
  await win.waitForTimeout(250)
  const tasks = await sample()
  if (!tasks.some((t) => t.name.includes(NAME))) {
    goneAfter = Date.now() - t0
    break
  }
}
check('完成后该条自己消失了，不用手点「清除已完成」', goneAfter !== null, `${goneAfter} ms`)
check('队列空了后面板整个收起来', (await win.locator('.transfer-panel').count()) === 0)

// ---------- 清理 ----------
const input = win.locator('.tab-content:visible .xterm-helper-textarea').first()
await input.click()
await win.keyboard.type(`rm -f /root/${NAME}`)
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1500)
check('远端测试文件已清理', !(await rows()).includes(NAME))

rmSync(LOCAL_DIR, { recursive: true, force: true })
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)

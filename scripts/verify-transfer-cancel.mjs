/**
 * 传输取消验证。
 *
 * 上传一个够大的文件，在「传输中」点界面上的取消按钮，确认：
 *   1. 状态真的变成「已取消」，而不是转完了才说取消
 *   2. 远端不会留下半截文件
 *   3. 取消那条也会自动消失
 *
 * 两个方向都验：上传走拖拽入队，下载用 app.evaluate 在主进程里把原生保存
 * 对话框换成固定路径（那个框 Playwright 点不了），其余全是真代码。
 * 方向不同意味着「清理半截文件」的目标不同 —— 上传删远端、下载删本地，
 * 本地那次删除曾经和文件句柄释放赛跑，留下过半截文件。
 *
 * 用法：node scripts/verify-transfer-cancel.mjs
 * 前置：npm run build，且已保存一个可连接的设备
 *
 * 远端只做：写入一个测试文件、最后确认已删除。不安装任何东西。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, openSync, writeSync, closeSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

mkdirSync('shots', { recursive: true })

const NAME = 'dox-cancel-test.bin'
const SIZE_MB = 40
const LOCAL_DIR = join(tmpdir(), 'dox-cancel-test')
rmSync(LOCAL_DIR, { recursive: true, force: true })
mkdirSync(LOCAL_DIR, { recursive: true })
const LOCAL_FILE = join(LOCAL_DIR, NAME)

const CHUNK = Buffer.alloc(1024 * 1024, 9)
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

const taskState = (name = NAME) =>
  win.evaluate((name) => {
    const row = [...document.querySelectorAll('.task')].find((t) =>
      (t.querySelector('.task-name')?.textContent ?? '').includes(name)
    )
    if (!row) return null
    return {
      status: (row.querySelector('.task-status')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      width: row.querySelector('.progress-bar')?.style?.width ?? '',
      // 取消按钮只在 pending / active 时存在
      hasCancel: !!row.querySelector('button[title="取消"]')
    }
  }, name)

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

/** 终端输入框：造远端测试数据用 */
const input = win.locator('.tab-content:visible .xterm-helper-textarea').first()

// 起点清理
if ((await rows()).includes(NAME)) {
  const stale = win.locator('.explorer .row').filter({ hasText: NAME }).first()
  await stale.hover()
  await stale.locator('button[title="删除"]').click()
  await win.waitForTimeout(1800)
}
check('起点：远端没有该文件', !(await rows()).includes(NAME))

// ---------- 拖拽上传 ----------
const cdp = await win.context().newCDPSession(win)
const box = await win.locator('.explorer').boundingBox()
const x = Math.round(box.x + box.width / 2)
const y = Math.round(box.y + box.height / 2)
const data = { items: [], files: [resolve(LOCAL_FILE)], dragOperationsMask: 1 }

await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
await win.waitForTimeout(200)
await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })

// 等它真的开始传，并传了一部分（不是刚入队）
let mid = null
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(120)
  const s = await taskState()
  if (s && s.status.startsWith('传输中')) {
    const pct = Number.parseFloat(s.width)
    if (pct > 3 && pct < 90) {
      mid = { ...s, pct }
      break
    }
  }
}
console.log('取消前的状态:', JSON.stringify(mid))
check('传输中看到了取消按钮', !!mid?.hasCancel, JSON.stringify(mid))
await win.screenshot({ path: 'shots/34-cancel-available.png' })

if (!mid) {
  check('抓到了传输中的中间态', false, '没能采样到 3%~90% 之间的状态')
} else {
  // ---------- 点取消 ----------
  const t0 = Date.now()
  await win.locator('.transfer-panel button[title="取消"]').first().click()

  let canceledAt = null
  let sawDone = false
  for (let i = 0; i < 40; i++) {
    await win.waitForTimeout(150)
    const s = await taskState()
    if (!s) break
    if (s.status.startsWith('完成')) sawDone = true
    if (s.status.startsWith('已取消')) {
      canceledAt = Date.now() - t0
      break
    }
  }
  console.log('取消后:', JSON.stringify(await taskState()), `${canceledAt ?? '?'} ms`)
  check('点取消后状态变成「已取消」', canceledAt !== null, `${canceledAt} ms`)
  check('取消是真的中止，不是传完了才改名', !sawDone)

  // 取消后那条应自动消失
  let gone = false
  for (let i = 0; i < 40; i++) {
    await win.waitForTimeout(200)
    if ((await taskState()) === null) {
      gone = true
      break
    }
  }
  check('取消的条目也自动消失', gone)
}

// ---------- 远端不留半截文件 ----------
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1800)
check('远端没有残留半截文件', !(await rows()).includes(NAME), (await rows()).slice(-3).join(', '))

// ---------- 下载方向的取消 ----------
// 上传和下载共用同一段 pipe()，但「清理半截文件」的方向不同：上传删远端、
// 下载删本地。本地那次删除曾经和文件句柄释放赛跑（destroy 之后句柄还没放开
// 就 unlink，Windows 上 EBUSY），结果是「取消了，本地却留个半截文件」。
console.log('\n下载方向取消')
const DLDIR = join(tmpdir(), 'dox-cancel-dl')
rmSync(DLDIR, { recursive: true, force: true })
mkdirSync(DLDIR, { recursive: true })
const DLNAME = 'dox-cancel-dl.bin'
const DL_FILE = join(DLDIR, 'out.bin')
// 下载任务的显示名取自**本地**路径（createTask 用 basename(localPath)），
// 不是远端文件名 —— 按远端名去找会永远匹配不上
const DL_TASK_NAME = 'out.bin'

// 远端造一个够大的文件；同时把原生保存对话框换成固定路径
await input.click()
await win.keyboard.type(`dd if=/dev/zero of=/root/${DLNAME} bs=1M count=40 2>/dev/null && echo OK`)
await win.keyboard.press('Enter')
await win.waitForTimeout(7000)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1800)
check('远端大文件已就绪', (await rows()).includes(DLNAME))

await app.evaluate(({ dialog }, filePath) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath })
}, DL_FILE)

const dlRow = win.locator('.explorer .row').filter({ hasText: DLNAME }).first()
await dlRow.hover()
await dlRow.locator('button[title="下载"]').click()

let dlMid = null
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(150)
  const s = await taskState(DL_TASK_NAME)
  if (s && s.status.startsWith('传输中')) {
    const pct = Number.parseFloat(s.width)
    if (pct > 3 && pct < 90) {
      dlMid = pct
      break
    }
  }
}
check('下载进入传输中', dlMid !== null, `${dlMid}%`)
if (dlMid === null) {
  // 失败时把现场打出来：要么没入队（对话框没被替换掉），要么报错了
  console.log(
    '诊断:',
    JSON.stringify(
      await win.evaluate(async () => ({
        error: document.querySelector('.error-banner')?.textContent?.trim() ?? null,
        tasks: (await window.api.listTransfers()).map((t) => `${t.fileName}:${t.status}:${t.error ?? ''}`)
      }))
    )
  )
}

if (dlMid !== null) {
  await win.locator('.transfer-panel button[title="取消"]').first().click()
  for (let i = 0; i < 40; i++) {
    await win.waitForTimeout(200)
    const s = await taskState(DL_TASK_NAME)
    if (!s || s.status.startsWith('已取消')) break
  }
  // 句柄释放需要一点时间，别立刻断言
  await win.waitForTimeout(1200)
  const leftover = existsSync(DL_FILE)
  const size = leftover ? statSync(DL_FILE).size : 0
  check('本地没有残留半截文件', !leftover, leftover ? `${size} 字节` : '')
} else {
  check('抓到了下载的中间态', false)
}

await input.click()
await win.keyboard.type(`rm -f /root/${DLNAME}`)
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)
rmSync(DLDIR, { recursive: true, force: true })

rmSync(LOCAL_DIR, { recursive: true, force: true })
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)

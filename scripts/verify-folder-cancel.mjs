/**
 * 文件夹传输的「全部取消」验证。
 *
 * 用户报的问题：点文件夹的下载按钮，底部进度条一直跑，没有任何办法停下来。
 * 根因是文件夹传输会把目录展开成成百上千条任务，而取消按钮每条一个；
 * 更要命的是目录遍历还在继续，取消掉的总被新冒出来的补上。
 *
 * 这里驱动真实的「文件夹下载」路径：用 app.evaluate 在主进程里替换掉
 * dialog.showOpenDialog（原生目录选择框 Playwright 点不了），其余全走真代码。
 *
 * 用法：node scripts/verify-folder-cancel.mjs
 * 前置：npm run build，且已保存一个可连接的设备
 *
 * 远端只做：建一个测试目录（若干小文件）、最后删掉它。不安装任何东西。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mkdirSync('shots', { recursive: true })

const DIR = 'dox-many-files'
const FILE_COUNT = 200
const LOCAL_OUT = join(tmpdir(), 'dox-folder-cancel')
rmSync(LOCAL_OUT, { recursive: true, force: true })
mkdirSync(LOCAL_OUT, { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const counts = () =>
  win.evaluate(() => {
    const out = { total: 0, active: 0, pending: 0, done: 0, canceled: 0, error: 0 }
    for (const row of document.querySelectorAll('.task')) {
      out.total++
      const s = row.querySelector('.task-status')?.textContent ?? ''
      if (s.includes('传输中')) out.active++
      else if (s.includes('排队中')) out.pending++
      else if (s.includes('完成')) out.done++
      else if (s.includes('已取消')) out.canceled++
      else if (s.includes('失败')) out.error++
    }
    return out
  })

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

// ---------- 远端造一个有几百个文件的目录 ----------
console.log(`远端造 ${FILE_COUNT} 个小文件…`)
const input = win.locator('.tab-content:visible .xterm-helper-textarea').first()
await input.click()
await win.keyboard.type(
  `rm -rf /root/${DIR} && mkdir -p /root/${DIR} && ` +
    `for i in $(seq 1 ${FILE_COUNT}); do head -c 131072 /dev/zero > /root/${DIR}/f$i.bin; done && echo READY`
)
await win.keyboard.press('Enter')
await win.waitForTimeout(8000)

await win.locator('button:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
await win.waitForTimeout(1200)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1500)
check('远端测试目录已就绪', (await rows()).includes(DIR))

// ---------- 替换掉原生目录选择框 ----------
// Playwright 点不了 Electron 的原生对话框；只替换这一个函数，其余走真代码
await app.evaluate(({ dialog }, dir) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
}, LOCAL_OUT)

// ---------- 点文件夹的下载按钮 ----------
console.log('\n开始下载文件夹…')
const row = win.locator('.explorer .row').filter({ hasText: DIR }).first()
await row.hover()
await row.locator('button[title^="下载文件夹"]').click()

// 等任务真的铺开（说明遍历在往里塞）
let peak = 0
let sawActive = false
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(200)
  const c = await counts()
  peak = Math.max(peak, c.total)
  if (c.active > 0) sawActive = true
  if (c.total >= 30) break
}
const before = await counts()
console.log('取消前:', JSON.stringify(before), '峰值条数', peak)
check('文件夹被展开成了多条任务', before.total > 5, `${before.total} 条`)
check('确有任务在传输中', sawActive)
await win.screenshot({ path: 'shots/36-folder-downloading.png' })

check('面板头部出现了「全部取消」', (await win.locator('.transfer-panel button[title="全部取消"]').count()) > 0)

// ---------- 全部取消 ----------
const t0 = Date.now()
await win.locator('.transfer-panel button[title="全部取消"]').click()

// 关键断言：取消之后不许再有新的任务冒出来，也不许还有在传的
let stillRunning = 0
let afterPeak = 0
let stableRounds = 0
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(250)
  const c = await counts()
  afterPeak = Math.max(afterPeak, c.total)
  if (c.active > 0 || c.pending > 0) {
    stillRunning++
    stableRounds = 0
  } else {
    stableRounds++
    if (stableRounds >= 4) break
  }
}
console.log(`取消后 ${Date.now() - t0} ms：`, JSON.stringify(await counts()), '期间峰值条数', afterPeak)

check('取消后不再有任务在传输或排队', stableRounds >= 4, `仍有动静的采样次数 ${stillRunning}`)
check(
  '目录遍历被真正中断（没有继续冒出新任务）',
  afterPeak <= peak + 2,
  `${peak} → ${afterPeak}`
)
// 自动消失是 3 秒后，上面那个循环在「安静下来」就退出了，这里得单独等
let panelGone = false
for (let i = 0; i < 40; i++) {
  await win.waitForTimeout(250)
  if ((await win.locator('.transfer-panel').count()) === 0) {
    panelGone = true
    break
  }
}
check('取消的那些条目随后自动消失', panelGone)
await win.screenshot({ path: 'shots/37-folder-canceled.png' })

// ---------- 清理 ----------
await input.click()
await win.keyboard.type(`rm -rf /root/${DIR}`)
await win.keyboard.press('Enter')
await win.waitForTimeout(2000)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1500)
check('远端测试目录已清理', !(await rows()).includes(DIR))

rmSync(LOCAL_OUT, { recursive: true, force: true })
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)

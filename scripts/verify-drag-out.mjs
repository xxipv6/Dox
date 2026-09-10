/**
 * 拖出下载验证（文件 + 文件夹）。
 *
 * 在行上派发一次真实的 dragstart，走完整条链路：
 * 渲染层 preventDefault → IPC → 主进程 stat/限量 → 递归下载到本地临时目录 →
 * webContents.startDrag。断言打在**本地临时目录真的落了正确的内容**上 ——
 * 这是拖出唯一有意义的结果，「IPC 没报错」说明不了什么。
 *
 * ⚠️ 一处无法在无头环境里验证：操作系统层面的拖拽手势本身（鼠标按住拖出去）
 * 需要真实指针。这里验的是「交给系统拖动之前的一切」，以及
 * startDrag 有没有被 Electron 拒绝。
 *
 * 用法：node scripts/verify-drag-out.mjs
 * 前置：npm run build，且已保存一个可连接的设备
 *
 * 远端只做：建一个测试目录与文件、最后删掉它。不安装任何东西。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mkdirSync('shots', { recursive: true })

const DIR_NAME = 'dox-dragout-test'
const FILE_NAME = 'dox-dragout-single.txt'
const STAMP = String(Date.now())
const DRAG_DIR = join(tmpdir(), 'dox-drag')

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const local = (name) => join(DRAG_DIR, name)
const readLocal = (name) => (existsSync(local(name)) ? readFileSync(local(name), 'utf8').trim() : null)

// 起点清干净，别让上一轮的残留变成假通过
rmSync(DRAG_DIR, { recursive: true, force: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

const rows = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.explorer .file-list .row')].map((r) =>
      (r.querySelector('.file-name')?.textContent ?? '').trim()
    )
  )

/** 在指定行上派发一次真实 dragstart，返回拖出过程中的可见报错 */
async function dragOut(name) {
  const row = win.locator('.explorer .row').filter({ hasText: name }).first()
  await row.scrollIntoViewIfNeeded()
  await row.evaluate((el) => {
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))
  })
  // 下载是异步的，等主进程走完；文件夹要递归，多给点时间
  for (let i = 0; i < 40; i++) {
    await win.waitForTimeout(250)
    const busy = await win.evaluate(() => !!document.querySelector('.drag-hint'))
    const err = await win.evaluate(
      () => document.querySelector('.error-banner')?.textContent?.trim() ?? ''
    )
    if (err) return { error: err }
    if (!busy && i > 1) return { error: null }
  }
  return { error: null, timeout: true }
}

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

// ---------- 准备远端测试数据：一个文件 + 一个两层目录 ----------
console.log('准备远端测试数据…')
const input = win.locator('.tab-content:visible .xterm-helper-textarea').first()
await input.click()
await win.keyboard.type(
  `mkdir -p /root/${DIR_NAME}/sub && echo ${STAMP}-top > /root/${DIR_NAME}/a.txt ` +
    `&& echo ${STAMP}-nested > /root/${DIR_NAME}/sub/b.txt && echo ${STAMP}-single > /root/${FILE_NAME}`
)
await win.keyboard.press('Enter')
await win.waitForTimeout(2500)

await win.locator('button:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
await win.waitForTimeout(1200)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1500)

const listing = await rows()
check('远端测试目录已就绪', listing.includes(DIR_NAME), listing.slice(-4).join(', '))
check('远端测试文件已就绪', listing.includes(FILE_NAME))

// ---------- 单文件拖出 ----------
console.log('\n单文件拖出')
const fileRes = await dragOut(FILE_NAME)
check('单文件拖出没有报错', fileRes.error === null, fileRes.error ?? '')
check('本地临时目录出现了该文件', existsSync(local(FILE_NAME)), local(FILE_NAME))
check('内容正确', readLocal(FILE_NAME) === `${STAMP}-single`, String(readLocal(FILE_NAME)))

// ---------- 文件夹拖出（递归）----------
console.log('\n文件夹拖出')
const dirRes = await dragOut(DIR_NAME)
check('文件夹拖出没有报错', dirRes.error === null, dirRes.error ?? '')
await win.screenshot({ path: 'shots/32-drag-out.png' })
check('本地出现了目录', existsSync(local(DIR_NAME)))
check('目录内的文件已落地', existsSync(join(local(DIR_NAME), 'a.txt')))
check(
  '嵌套子目录也递归拉下来了',
  existsSync(join(local(DIR_NAME), 'sub', 'b.txt')),
  join(local(DIR_NAME), 'sub', 'b.txt')
)
check('顶层文件内容正确', readLocal(join(DIR_NAME, 'a.txt')) === `${STAMP}-top`)
check('嵌套文件内容正确', readLocal(join(DIR_NAME, 'sub', 'b.txt')) === `${STAMP}-nested`)

// ---------- 取消一次正在进行的拖出 ----------
// 拖出是「先把远端拉到本地、再交给系统拖动」，目录还要递归 —— 这中间用户
// 完全有理由反悔。之前这条路完全没有取消入口，点了只能干等它拉完。
console.log('\n取消进行中的拖出')
const BIG = 'dox-dragout-big.bin'
await input.click()
await win.keyboard.type(`dd if=/dev/zero of=/root/${BIG} bs=1M count=40 2>/dev/null`)
await win.keyboard.press('Enter')
await win.waitForTimeout(6000)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1800)
check('大文件已就绪', (await rows()).includes(BIG))

// 不 await：拖出会一直等到拷完，我们要在它进行中插进去点取消
const row = win.locator('.explorer .row').filter({ hasText: BIG }).first()
await row.scrollIntoViewIfNeeded()
await row.evaluate((el) => {
  el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))
})

// 等提示条出现（说明主进程已经在拉了），再点取消
let hintSeen = false
for (let i = 0; i < 40; i++) {
  await win.waitForTimeout(150)
  if ((await win.locator('.drag-hint').count()) > 0) {
    hintSeen = true
    break
  }
}
check('拖出过程中出现「取到本地」提示与取消入口', hintSeen)
check('提示条里有取消按钮', (await win.locator('.drag-cancel').count()) > 0)
await win.screenshot({ path: 'shots/35-drag-cancel.png' })

const t0 = Date.now()
await win.locator('.drag-cancel').click()
let canceledAfter = null
for (let i = 0; i < 40; i++) {
  await win.waitForTimeout(150)
  if ((await win.locator('.drag-hint').count()) === 0) {
    canceledAfter = Date.now() - t0
    break
  }
}
check('点取消后立刻停下（不是等传完）', canceledAfter !== null, `${canceledAfter} ms`)
check(
  '取消后本地不留半截文件',
  !existsSync(local(BIG)),
  local(BIG)
)
check(
  '取消不弹错误横幅（用户自己点的，不是失败）',
  (await win.locator('.error-banner').count()) === 0
)

// ---------- 清理 ----------
console.log('\n清理')
await input.click()
await win.keyboard.type(`rm -rf /root/${DIR_NAME} /root/${FILE_NAME} /root/dox-dragout-big.bin`)
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1500)
const after = await rows()
check(
  '远端测试数据已清理',
  !after.includes(DIR_NAME) && !after.includes(FILE_NAME) && !after.includes('dox-dragout-big.bin')
)

// 本地临时目录留给应用退出时清理，这里也清一次，别在用户机器上留东西
rmSync(DRAG_DIR, { recursive: true, force: true })
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)

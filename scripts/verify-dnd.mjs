/**
 * 拖拽上传端到端验证。
 *
 * 用 CDP 的 Input.dispatchDragEvent 发一次**真实**拖放（带上文件系统路径），
 * 而不是在页面里造一个合成 DataTransfer —— 合成出来的 File 没有真实路径，
 * webUtils.getPathForFile 会返回空串，整条要验的链路被绕开。
 *
 * 断言不止「队列里出现任务」，而是一路验到字节：拖放 → 远端出现该文件 →
 * 双击用内置编辑器打开 → 内容里确实有本地写入的标记。
 *
 * 用法：node scripts/verify-dnd.mjs
 * 前置：npm run build，且已保存一个可连接的设备
 *
 * 对远端只做：写入一个测试文件、最后删掉它。不安装任何东西。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

mkdirSync('shots', { recursive: true })

const NAME = 'dox-drag-upload.txt'
const LOCAL_DIR = join(tmpdir(), 'dox-dnd-test')
rmSync(LOCAL_DIR, { recursive: true, force: true })
mkdirSync(LOCAL_DIR, { recursive: true })
const LOCAL_FILE = join(LOCAL_DIR, NAME)
const MARKER = `drag-upload-${Date.now()}`
writeFileSync(LOCAL_FILE, `${MARKER}\nsecond line\n`)

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

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
  // 签名是 (fn, arg, options)：漏掉 arg 会把 timeout 当成页面函数参数
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

// 起点清理：上一轮若是中途失败，测试文件会留在远端，
// 让它变成「第一次能跑、第二次就挂」的脚本 —— 这坑刚在别的脚本里踩过。
if ((await rows()).includes(NAME)) {
  console.log('清理上一轮残留的远端测试文件…')
  const stale = win.locator('.explorer .row').filter({ hasText: NAME }).first()
  await stale.hover()
  await stale.locator('button[title="删除"]').click()
  await win.waitForTimeout(1800)
}
check('起点：远端没有该文件', !(await rows()).includes(NAME))

// ---------- 发一次真实拖放 ----------
const cdp = await win.context().newCDPSession(win)
const box = await win.locator('.explorer').boundingBox()
const x = Math.round(box.x + box.width / 2)
const y = Math.round(box.y + box.height / 2)
const data = { items: [], files: [resolve(LOCAL_FILE)], dragOperationsMask: 1 }

console.log('\n拖放中…')
await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
// 高亮由 dragover 驱动（模板里是 @dragover.prevent="dragOver = true"），
// 所以必须等 dragOver 发出去之后再断言，只发 dragEnter 时它还是 false
await win.waitForTimeout(400)
check('拖入时面板高亮', await win.evaluate(() => !!document.querySelector('.explorer.drag-over')))

await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })
await win.waitForTimeout(2500)
await win.screenshot({ path: 'shots/30-dropped.png' })

// ---------- 队列里的任务 ----------
const task = await win.evaluate(async (name) => {
  const list = await window.api.listTransfers()
  const t = list.find((x) => x.fileName === name || (x.localPath ?? '').endsWith(name))
  return t ? { status: t.status, error: t.error ?? null, remotePath: t.remotePath } : null
}, NAME)
console.log('传输任务:', JSON.stringify(task))
check('拖放产生了上传任务', !!task, JSON.stringify(task))
check('上传成功（状态 done、无错误）', task?.status === 'done' && !task?.error, JSON.stringify(task))

// ---------- 远端确实多出这个文件 ----------
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1800)
const after = await rows()
check('远端文件列表出现了它', after.includes(NAME), after.slice(0, 4).join(', '))

// ---------- 验字节：打开它看内容 ----------
// 传输面板浮在文件列表上面（absolute + z-index 10），收起来也还是盖着底部那几行。
// 要点击被盖住的行，只能把队列清空让面板整个消失 —— 顺带也验了「清除已完成」。
const clearBtn = win.locator('.transfer-panel button[title="清除已完成"]')
if (await clearBtn.count()) {
  await clearBtn.click()
  await win.waitForTimeout(600)
}
check('清空后传输面板消失', (await win.locator('.transfer-panel').count()) === 0)

const target = win.locator('.explorer .row').filter({ hasText: NAME }).first()
await target.scrollIntoViewIfNeeded()
await target.dblclick()
await win.waitForTimeout(3000)
const content = await win.evaluate(() =>
  [...document.querySelectorAll('.cm-line')].map((e) => e.textContent).join('\n')
)
check('内容与本地写入一致（字节确实到了）', content.includes(MARKER), JSON.stringify(content.slice(0, 80)))
await win.screenshot({ path: 'shots/31-content.png' })

// ---------- 清理：删掉远端测试文件 ----------
await win.locator('.etab-close').first().click().catch(() => {})
await win.waitForTimeout(500)
const row = win.locator('.explorer .row').filter({ hasText: NAME }).first()
await row.hover()
await row.locator('button[title="删除"]').click()
await win.waitForTimeout(2000)
check('清理后远端不再有该文件', !(await rows()).includes(NAME))

rmSync(LOCAL_DIR, { recursive: true, force: true })
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)

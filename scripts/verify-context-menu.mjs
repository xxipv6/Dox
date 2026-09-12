/**
 * SFTP 右键菜单验证。
 *
 * 覆盖：
 *   菜单里有什么、右键的选区规则（点选区内 / 选区外）、Esc 关闭、
 *   多选下载（只弹一次目录框、每一项都真的落地）、右键空白处
 *
 * 原生目录选择框 Playwright 点不了，用 app.evaluate 在主进程里替换掉它，
 * 其余全部走真实代码路径。落盘结果断言在**本地文件内容**上 ——
 * 「弹了框、没报错」说明不了文件真的下来了。
 *
 * 用法：node scripts/verify-context-menu.mjs
 * 前置：npm run build，且已保存一个可连接的设备
 *
 * 远端只做：建三个测试文件、最后删掉。不安装任何东西。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mkdirSync('shots', { recursive: true })

const STAMP = String(Date.now())
const A = 'dox-ctx-a.txt'
const B = 'dox-ctx-b.txt'
const OUT_DIR = join(tmpdir(), `dox-ctx-out-${STAMP}`)

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

const rowOf = (name) => win.locator('.explorer .row').filter({ hasText: name }).first()
const menuItems = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.context-menu .menu-item')].map((b) => ({
      text: (b.textContent ?? '').trim(),
      disabled: b.disabled
    }))
  )
const selectedNames = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.explorer .file-list .row.selected')]
      .map((r) => (r.querySelector('.file-name')?.textContent ?? '').trim())
      .sort()
  )
const readOut = (name) =>
  existsSync(join(OUT_DIR, name)) ? readFileSync(join(OUT_DIR, name), 'utf8').trim() : null

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

console.log('准备远端测试数据…')
const input = win.locator('.tab-content:visible .xterm-helper-textarea').first()
await input.click()
await win.keyboard.type(
  `echo ${STAMP}-a > /root/${A} && echo ${STAMP}-b > /root/${B}`
)
await win.keyboard.press('Enter')
await win.waitForTimeout(2000)

await win.locator('button:has-text("SFTP")').click()
await win.waitForFunction(
  () => document.querySelectorAll('.explorer .file-list .row').length > 0,
  undefined,
  { timeout: 15000 }
)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForFunction(
  () => [...document.querySelectorAll('.explorer .file-name')].some((n) => n.textContent === 'dox-ctx-a.txt'),
  undefined,
  { timeout: 15000 }
)
await win.waitForTimeout(600)

// ---------- 1. 单选右键 ----------
console.log('\n单选右键')
await rowOf(A).click({ button: 'right' })
await win.waitForTimeout(300)
let items = await menuItems()
check('右键弹出了菜单', items.length === 4, JSON.stringify(items))
check('菜单是「下载 / 打包 / 重命名 / 删除」', items.map((i) => i.text).join('/') === '下载/打包/重命名/删除', items.map((i) => i.text).join('/'))
check('右键把该行选上了', JSON.stringify(await selectedNames()) === JSON.stringify([A]))
await win.screenshot({ path: 'shots/40-context-menu-single.png' })

await win.keyboard.press('Escape')
await win.waitForTimeout(300)
check('Esc 关掉菜单', (await win.locator('.context-menu').count()) === 0)

// ---------- 2. 右键选区外的一行 ----------
console.log('\n右键选区外')
await rowOf(A).click() // 先选中 A
await win.waitForTimeout(200)
await rowOf(B).click({ button: 'right' }) // 再右键 B
await win.waitForTimeout(300)
check('右键选区外会改选成那一行', JSON.stringify(await selectedNames()) === JSON.stringify([B]))
await win.keyboard.press('Escape')
await win.waitForTimeout(200)

// ---------- 3. 多选后右键 ----------
console.log('\n多选后右键')
await rowOf(A).click()
await win.waitForTimeout(150)
await rowOf(B).click({ modifiers: ['Control'] })
await win.waitForTimeout(200)
await rowOf(A).click({ button: 'right' }) // 点在已选中的行上
await win.waitForTimeout(300)
items = await menuItems()
check('右键选区内的行会保持整片选区', JSON.stringify(await selectedNames()) === JSON.stringify([A, B]))
check('菜单变成「下载这 2 项」', items[0]?.text === '下载这 2 项', String(items[0]?.text))
check('打包也带上数量', items[1]?.text === '打包这 2 项' && items[1]?.disabled === false, JSON.stringify(items[1]))
check('多选时重命名不可点', items[2]?.disabled === true, JSON.stringify(items[2]))
check('删除也带上数量', items[3]?.text === '删除这 2 项', String(items[3]?.text))
await win.screenshot({ path: 'shots/41-context-menu-multi.png' })

// ---------- 4. 多选下载：只弹一次目录框，两项都落地 ----------
console.log('\n多选下载')
// 数一数原生目录框被弹了几次：多选下载的关键就是「只问一次」
let pickCount = 0
await app.evaluate(
  ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => {
      globalThis.__pickCount = (globalThis.__pickCount ?? 0) + 1
      return { canceled: false, filePaths: [dir] }
    }
  },
  OUT_DIR
)

await win.locator('.context-menu .menu-item:has-text("下载这 2 项")').click()
let landed = false
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(250)
  if (readOut(A) === `${STAMP}-a` && readOut(B) === `${STAMP}-b`) {
    landed = true
    break
  }
}
check(`文件 A 落地且内容正确`, readOut(A) === `${STAMP}-a`, String(readOut(A)))
check(`文件 B 落地且内容正确`, readOut(B) === `${STAMP}-b`, String(readOut(B)))
check('两项都到齐', landed)
pickCount = await app.evaluate(() => globalThis.__pickCount ?? 0)
check('只弹了一次目录选择框', pickCount === 1, `弹了 ${pickCount} 次`)
check('菜单点完就关掉', (await win.locator('.context-menu').count()) === 0)

// ---------- 5. 单选下载走保存框（保持原行为）----------
console.log('\n单选下载')
const SAVE_TO = join(OUT_DIR, 'renamed-by-dialog.txt')
await app.evaluate(({ dialog }, filePath) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath })
}, SAVE_TO)
// 先把选区收成一项：上一步多选下载之后 A 还在选中态里，
// 直接右键会得到「下载这 2 项」，测不到单文件那条路
await rowOf(A).click()
await win.waitForTimeout(200)
check('单选后只剩一项被选中', JSON.stringify(await selectedNames()) === JSON.stringify([A]))
await rowOf(A).click({ button: 'right' })
await win.waitForTimeout(300)
await win.locator('.context-menu .menu-item:has-text("下载")').first().click()
for (let i = 0; i < 40; i++) {
  await win.waitForTimeout(250)
  if (existsSync(SAVE_TO)) break
}
check(
  '单文件下载仍走保存框（文件名可改）',
  existsSync(SAVE_TO) && readFileSync(SAVE_TO, 'utf8').trim() === `${STAMP}-a`,
  SAVE_TO
)

// ---------- 6. 右键空白处 ----------
console.log('\n右键空白处')
await rowOf(A).click()
await win.waitForTimeout(200)
check('先选中一项', (await selectedNames()).length === 1)
/*
 * 空白处右键。当前目录条目撑满且溢出，真实鼠标点不到空白区，
 * 所以两种情形分开：内容不满一屏就点最后一行下方，否则直接向
 * .file-list 自身派发一次 contextmenu，验 @contextmenu.self 的绑定。
 */
const hasBlank = await win.evaluate(() => {
  const list = document.querySelector('.explorer .file-list')
  return !!list && list.scrollHeight <= list.clientHeight - 20
})
if (hasBlank) {
  const box = await win.locator('.explorer .file-list').boundingBox()
  await win.mouse.click(box.x + 5, box.y + box.height - 5, { button: 'right' })
} else {
  await win.locator('.explorer .file-list').dispatchEvent('contextmenu')
}
await win.waitForTimeout(300)
check('右键空白处不弹菜单', (await win.locator('.context-menu').count()) === 0)
check('右键空白处清空选中', (await selectedNames()).length === 0)

// ---------- 清理 ----------
console.log('\n清理')
await input.click()
await win.keyboard.type(`rm -f /root/${A} /root/${B}`)
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1200)
const left = await win.evaluate(() =>
  [...document.querySelectorAll('.explorer .file-name')].map((n) => n.textContent)
)
check('远端测试数据已清理', !left.includes(A) && !left.includes(B))
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)

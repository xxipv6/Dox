/**
 * 验证「SFTP 双击文件 → 内置编辑器查看/编辑/保存回远端」全链路。
 *
 * 用第一条已保存设备真实连上去，在 home 目录建一个临时文件，
 * 走完整流程后用终端 cat 核对写回内容，最后删掉临时文件。
 * 不用假密码：这条路径必须真的连上服务器才算验证过。
 *
 * 用法：node scripts/verify-editor.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

const SCRATCH = 'dox-editor-verify.txt'
const BINARY = 'dox-editor-verify.bin'
const BIG = 'dox-editor-verify-big.txt'
const MARKER = 'dox-marker-alpha'

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()

const errors = []
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
win.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`))
win.on('dialog', (d) => d.accept())

await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
  { timeout: 10000 }
)

// 布局是会持久化的：上一个脚本留下的标签会被自动恢复出来，导致这里的
// 「可见终端」未必是本次要操作的那个。开跑前清空，保证从干净状态开始。
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await win.reload()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
  { timeout: 10000 }
)

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

/** 当前可见（非 display:none）标签页里的终端输入框 */
const termInput = () => win.locator('.tab-content:visible .xterm-helper-textarea')

async function termRun(cmd, settleMs = 900) {
  await termInput().click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(settleMs)
}

/**
 * 终端输出读不回来：本项目用 WebGL 渲染器，xterm 6 的字符全在 canvas 上，
 * DOM 里没有 .xterm-rows 可读。所以写回是否真的落到服务器，改由编辑器
 * 「重载」（重新 sftpReadText）来证明 —— 那是真实的第二次服务端读取。
 */
/**
 * 取编辑器里的真实文档文本。
 * 不能用 .cm-content 的 textContent：CodeMirror 每个逻辑行是一个 .cm-line，
 * 直接 textContent 拼接会把换行符吃掉，两行内容看起来像粘在一起。
 */
const editorText = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.editor-panel .cm-line')]
      .map((l) => l.textContent ?? '')
      .join('\n')
  )

// ---------- 1. 连接第一条已保存设备 ----------
const deviceCount = await win.locator('.device').count()
if (!deviceCount) {
  console.log('没有已保存设备，无法验证。')
  await app.close()
  process.exit(1)
}
const deviceName = await win.locator('.device .device-name').first().textContent()
console.log(`连接设备：${deviceName?.trim()}`)
// 直接双击行（界面提示就是「双击连接」）。行内 ▶ 按钮受 hover 才显示，
// Playwright 会在 hover 之前先做可见性检查，点不到。
await win.locator('.device .device-name').first().dblclick()

// shell 通道建立 = 出现第二个终端面板（首个是启动时的本地终端）
try {
  await win.waitForFunction(
    () => document.querySelectorAll('.terminal-container').length >= 2,
    { timeout: 25000 }
  )
  check('SSH 连接建立', true)
} catch {
  const err = await win.locator('.tab-placeholder').first().textContent().catch(() => '')
  check('SSH 连接建立', false, err?.trim() || '超时')
  await app.close()
  process.exit(1)
}
await win.waitForTimeout(1500)

// ---------- 2. 造一个临时文件 ----------
await termRun(`echo ${MARKER} > ~/${SCRATCH}`)

// ---------- 3. 打开 SFTP 并刷新 ----------
await win.locator('button:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })

const rowOf = (name) => win.locator('.explorer .row').filter({ hasText: name }).first()

/**
 * 轮询等文件出现在列表里。
 * 生成大文件（head -c 3000000）要花时间，写完之前刷新是刷不出来的 ——
 * 一次性刷新会让后面「文件已就位」的断言随机失败。
 */
async function waitForRow(name, timeoutMs = 10000) {
  const row = rowOf(name)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await row.count()) return row
    await win.locator('.explorer .icon-btn[title="刷新"]').click()
    await win.waitForTimeout(700)
  }
  return row
}

const row = await waitForRow(SCRATCH)
check('SFTP 列表中可见该文件', (await row.count()) > 0)
if (!(await row.count())) {
  await app.close()
  process.exit(1)
}

// ---------- 4. 双击打开 ----------
await row.dblclick()
await win.locator('.editor-panel .cm-content').waitFor({ timeout: 10000 })
const opened = await win.locator('.editor-panel .cm-content').textContent()
check('双击文件后编辑器打开并显示内容', (opened ?? '').includes(MARKER), JSON.stringify(opened))
check('编辑器标签显示文件名', (await win.locator('.etab-name').first().textContent()) === SCRATCH)
check('无未保存标记（刚打开）', (await win.locator('.dirty-dot').count()) === 0)

// ---------- 5. 编辑 → 脏标记出现 ----------
await win.locator('.editor-panel .cm-content').click()
await win.keyboard.press('Control+End')
await win.keyboard.type('edited-line')
await win.waitForTimeout(300)
check('编辑后出现未保存标记 ●', (await win.locator('.dirty-dot').count()) === 1)

// ---------- 6. Ctrl+S 保存 ----------
await win.keyboard.press('Control+s')
await win.waitForTimeout(1200)
check('保存后未保存标记消失', (await win.locator('.dirty-dot').count()) === 0)
check('出现「已保存」提示', (await win.locator('.saved-hint').count()) === 1)

// 在真正打开了文件、且三栏都在的状态下截图，用于人工核对布局
await win.screenshot({ path: 'shots/30-editor-open.png' })

// 编辑器打开后文件列表会收窄，固定宽度的列若不同步收掉，
// 文件名会被挤成 0 宽（列表退化成一排只有图标的空行）。这条就是防它回潮。
const nameBox = await win.evaluate(() => {
  const names = [...document.querySelectorAll('.explorer .file-name')]
  if (!names.length) return { count: 0, minWidth: 0, sample: '' }
  const widths = names.map((n) => n.clientWidth)
  return {
    count: names.length,
    minWidth: Math.min(...widths),
    sample: names[0].textContent ?? ''
  }
})
check(
  '编辑器打开时文件列表仍能看清文件名',
  nameBox.count > 0 && nameBox.minWidth >= 60 && nameBox.sample.length > 0,
  `最窄 ${nameBox.minWidth}px，样例 ${JSON.stringify(nameBox.sample)}`
)
console.log(
  '  三栏宽度:',
  await win.evaluate(() => {
    const w = (sel) => document.querySelector(sel)?.clientWidth ?? 0
    return {
      window: globalThis.innerWidth,
      areaClass: document.querySelector('.terminal-area')?.className,
      terminal: w('.terminal-stack'),
      explorer: w('.explorer'),
      editor: w('.editor-panel')
    }
  })
)

// ---------- 7. 重载 = 重新从服务器读，据此确认真的写回 ----------
const EXPECTED = `${MARKER}\nedited-line`
await win.locator('.editor-panel button:has-text("重载")').click()
await win.waitForTimeout(1200)
const reloaded = await editorText()
check('重载后内容与编辑结果完全一致（已写回远端）', reloaded === EXPECTED, JSON.stringify(reloaded))
check('原内容未被破坏', (reloaded ?? '').includes(MARKER))
check('换行结构保持（两行，不是粘成一行）', (reloaded ?? '').split('\n').length === 2)

// ---------- 8. 保存后 mtime 已更新，再次保存不应误报冲突 ----------
await win.locator('.editor-panel .cm-content').click()
await win.keyboard.press('Control+End')
await win.keyboard.type('-again')
await win.keyboard.press('Control+s')
await win.waitForTimeout(1200)
check('连续保存不误报外部改动冲突', (await win.locator('.editor-error').count()) === 0)
check('第二次保存也未保存标记清零', (await win.locator('.dirty-dot').count()) === 0)

// ---------- 9. 二进制文件必须被挡住 ----------
// 必须用真实二进制：/dev/urandom 的短前缀可能不含 NUL，那种文件按定义就是文本，
// 拿它当用例会时过时不过
await termRun(`head -c 4096 /bin/ls > ~/${BINARY}`)
const binRow = await waitForRow(BINARY)
check('二进制测试文件已就位', (await binRow.count()) > 0)
await binRow.dblclick()
await win.waitForTimeout(1200)
const binErr = await win.locator('.editor-panel .editor-error').textContent().catch(() => '')
check('二进制文件不进编辑器并给出提示', (binErr ?? '').includes('二进制'), JSON.stringify(binErr?.trim()))

// ---------- 10. 超过 2MB 必须被挡住 ----------
await termRun(`head -c 3000000 /dev/zero > ~/${BIG}`)
const bigRow = await waitForRow(BIG)
check('超限测试文件已就位', (await bigRow.count()) > 0)
await bigRow.dblclick()
await win.waitForTimeout(1500)
const bigErr = await win.locator('.editor-panel .editor-error').textContent().catch(() => '')
check('超大文件被拒绝并提示改走下载', (bigErr ?? '').includes('上限'), JSON.stringify(bigErr?.trim()))

// ---------- 11. 清理 ----------
await termRun(`rm -f ~/${SCRATCH} ~/${BINARY} ~/${BIG}`)
await win.locator('.explorer .icon-btn[title="刷新"]').click()
await win.waitForTimeout(900)
let leftover = 0
for (const name of [SCRATCH, BINARY, BIG]) leftover += await rowOf(name).count()
check('临时文件已清理干净（未在服务器上残留）', leftover === 0, `残留 ${leftover} 个`)

await win.screenshot({ path: 'shots/30-editor.png' })

console.log('\n渲染进程报错:', errors.length ? errors.slice(0, 5) : '无')
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')

await app.close()

/**
 * 广播下发（一处敲键，多个会话同时执行）的端到端验证。
 *
 * 观测手法：**让 shell 自己作证**。开两个本地标签（两个独立 pty，同一台机器），
 * 在 A 里敲一条 `echo TAG $$ >> 文件` —— `$$` 由 shell 自己展开成各自的 PID。
 *
 *   - 目标有 2 个：文件里出现**两行、两个不同 PID** → 两个 shell 都执行了
 *   - 目标只剩 1 个（或广播关掉）：只多出**一行** → 没有扇出
 *
 * 这样断言不依赖终端怎么渲染（WebGL 画在 canvas 上，DOM 里读不到文本），
 * 也不依赖任何内部状态，只认「命令有没有真的在另一个 shell 里跑起来」。
 *
 * 覆盖的交互：开启即全勾 → 一键全不选 / 全选 → 单独取消某一个勾（排除）→ 关掉开关。
 *
 * 用法：node scripts/verify-broadcast.mjs
 * 前置：npm run dev（脚本用 --user-data-dir 起**独立**实例，不动你在跑的那个）
 */
import { _electron } from 'playwright'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 后台轮询/异步循环在窗口关掉后会抛未处理拒绝，直接把探测脚本带走
process.on('unhandledRejection', () => {})

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const stamp = Date.now()
/** 每一轮用不同的后缀，方便按行数分别统计「有几条命令真的执行了」 */
const TAG = `DOXBC-${stamp}-`
const receipt = join(tmpdir(), `dox-broadcast-${stamp}.log`)

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dox-bc-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5173/' }
})

try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.log(`  [渲染层报错] ${e.message}`))
  await win.waitForLoadState('domcontentloaded')
  // 清掉可能恢复出来的旧标签（隔离 userData 里通常本来就是空的）
  await win.waitForTimeout(1500)
  await win.evaluate(() => window.api.setLayout({ tabs: [] })).catch(() => {})
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  const waitTerm = (n) =>
    win.waitForFunction(
      (want) => document.querySelectorAll('.terminal-container').length >= want,
      n,
      { timeout: 25000 }
    )

  // ---- 起两个本地标签 ----
  await waitTerm(1)
  await win.waitForTimeout(2000)
  await win.locator('.tab-new').click()
  await waitTerm(2)
  await win.waitForTimeout(2500)
  check('两个本地标签都建起来了', (await win.locator('.tab').count()) === 2)

  // ---- 在 A 里敲一条带 TAG 的记账命令，回过头数文件里落了几行、几个不同 PID ----
  const bcBtn = win.locator('.bar-btn[title^="广播"]')
  const bulkBtn = win.locator('.bc-bulk')
  const boxes = win.locator('.tab-bc')
  const activeTerm = win.locator('.terminal-container:visible').first()
  const targets = async () => Number((await bcBtn.textContent())?.match(/(\d+)/)?.[1] ?? -1)

  /** 当前活动的标签页留在第一个，从它的终端敲一条命令，返回落进文件的行 */
  async function fire(tag) {
    await win.locator('.tab').first().click()
    await win.waitForTimeout(250)
    await activeTerm.click()
    await win.waitForTimeout(350)
    await win.keyboard.type(`echo ${tag} $$ >> ${receipt}`)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(2200)
    return readReceipt().filter((l) => l.includes(tag))
  }
  const shells = (lines) => new Set(lines.map((l) => l.split(/\s+/).pop())).size

  // ---- 打开广播：默认全部标签都勾上 ----
  await bcBtn.click()
  await win.waitForTimeout(400)
  check(
    '开启后勾选框出现在每个标签上',
    (await boxes.count()) === (await win.locator('.tab').count())
  )
  check('开启即全勾（不用挨个点）', (await win.locator('.tab-bc.on').count()) === 2)
  check('按钮上写着目标数 2（两个会话都连着）', (await targets()) === 2, String(await targets()))
  check('已全选时批量按钮写「全不选」', (await bulkBtn.textContent())?.trim() === '全不选')

  const onLines = await fire(`${TAG}ON`)
  console.log(`  全勾：文件里 ${onLines.length} 行，涉及 ${shells(onLines)} 个 shell`)
  check('全勾：两个 shell 都执行了（两行不同 PID）', shells(onLines) === 2, JSON.stringify(onLines))

  // ---- 一键全不选：目标清零，只剩当前会话 ----
  await bulkBtn.click()
  await win.waitForTimeout(400)
  check('全不选后一个勾都没有', (await win.locator('.tab-bc.on').count()) === 0)
  check('全不选后目标数为 0', (await targets()) === 0, String(await targets()))
  check('归零时批量按钮写「全选」', (await bulkBtn.textContent())?.trim() === '全选')

  const noneLines = await fire(`${TAG}NONE`)
  check('全不选：只有当前会话执行（一行）', noneLines.length === 1, JSON.stringify(noneLines))

  // ---- 一键全选：又都回来了 ----
  await bulkBtn.click()
  await win.waitForTimeout(400)
  const againLines = await fire(`${TAG}AGAIN`)
  check('全选：两个 shell 又都执行了', shells(againLines) === 2, JSON.stringify(againLines))

  // ---- 单独取消一个勾（排除法：全选之后挑掉一个）----
  // 取消的是**非当前**标签 → 目标只剩当前会话自己，sendInput 会排除源会话，等于没外发
  await boxes.nth(1).click()
  await win.waitForTimeout(400)
  check('取消一个勾后目标数降到 1', (await targets()) === 1, String(await targets()))
  check('当前标签仍是勾着的（点的那个勾只影响它自己）', (await win.locator('.tab-bc.on').count()) === 1)
  const exclLines = await fire(`${TAG}EXCL`)
  check('排除掉的那个会话没执行（只有一行）', exclLines.length === 1, JSON.stringify(exclLines))

  // ---- 关掉广播：勾选框收起来，只剩当前会话 ----
  await bcBtn.click()
  await win.waitForTimeout(400)
  check('关掉后勾选框收起来了', (await boxes.count()) === 0)
  check('关掉后批量按钮也收起来', (await bulkBtn.count()) === 0)
  const offLines = await fire(`${TAG}OFF`)
  check('广播关掉：只有当前会话执行（一行）', offLines.length === 1, JSON.stringify(offLines))

  // 截图前把开关状态再读一遍：截图里看到勾选框还在的话，得知道是真状态还是我看错了
  const finalState = await win.evaluate(() => ({
    on: document.querySelector('.bar-btn[title^="广播"]')?.classList.contains('on') ?? null,
    boxes: document.querySelectorAll('.tab-bc').length
  }))
  console.log(`  截图前的开关状态：${JSON.stringify(finalState)}`)
  check('截图前广播仍是关闭的（勾选框不该复活）', finalState.boxes === 0 && finalState.on === false)

  // 顺手把「开着广播时新开的标签自动入列」也验了（此前只有两个标签）
  await bcBtn.click()
  await win.waitForTimeout(300)
  await win.locator('.tab-new').click()
  await waitTerm(3)
  await win.waitForTimeout(2500)
  check('开着广播新开标签 → 自动入列（3 个标签全勾）', (await targets()) === 3, String(await targets()))

  await win.screenshot({ path: 'shots/broadcast-e2e.png' })
  console.log('  截图：shots/broadcast-e2e.png')
} catch (err) {
  check('探测过程未抛错', false, err instanceof Error ? err.message : String(err))
} finally {
  await app.close().catch(() => {})
  rmSync(receipt, { force: true })
  try {
    // 隔离实例偶发不退，按 userData 目录名精确清掉
    execFileSync('pkill', ['-f', 'dox-bc-'], { stdio: 'ignore' })
  } catch {
    /* 没有正好 */
  }
}

function readReceipt() {
  try {
    return readFileSync(receipt, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    return []
  }
}

console.log(failed ? '\n结论: 存在失败项' : '\n结论: 全部通过')
process.exit(failed ? 1 : 0)

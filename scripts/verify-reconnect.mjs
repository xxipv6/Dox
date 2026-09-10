/**
 * 断线重连 + 会话恢复端到端验证。
 *
 * 制造断线：在远端执行 `kill -9 $PPID`（杀掉本会话的 sshd 子进程）。
 * 这是唯一在远端执行的动作：不安装任何东西，只影响我们自己这一条会话，
 * 效果等同于网络被掐断（TCP 直接关闭），重连后 sshd 会自动起新的会话进程。
 * 之所以不用 `ss -K`：目标内核多数没开 CONFIG_INET_DIAG_DESTROY，
 * ss -K 会报告成功但实际不销毁 socket（已实测确认）。
 *
 * 读终端内容：默认的 WebGL 渲染器把字符画在 canvas 上，DOM 里没有文本行。
 * 这里先打开「字体连字」设置 —— 它会切到 DOM 渲染器，于是 .xterm-rows 可读。
 * 这是真实的用户设置项，不是为测试加的开关。
 *
 * 用法：node scripts/verify-reconnect.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()

const errors = []
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
win.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`))
win.on('dialog', (d) => d.accept())

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const termInput = () => win.locator('.tab-content:visible .xterm-helper-textarea')

/** 读可见终端里的文本（依赖 DOM 渲染器，见文件头注释） */
const termText = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.tab-content')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) =>
        [...el.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent ?? '').join('\n')
      )
      .join('\n')
  )

/**
 * 断言「某标记真的作为一行输出出现过」。
 * 不能用 includes：终端会回显敲进去的命令，而命令里往往就含这个标记，
 * 于是 `echo DOX_OK` 会被自己的命令行匹配上，检查假通过。
 */
function hasOutputLine(text, marker) {
  return new RegExp(`(^|\\n)\\s*${marker}\\s*(\\n|$)`, 'm').test(text)
}

/** 敲一条命令并等它的回显出现，避免在远端还没回显时就去断言 */
async function termRun(cmd, settleMs = 600) {
  await termInput().click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(settleMs)
  const head = cmd.slice(0, 24)
  for (let i = 0; i < 12; i++) {
    const now = await termText()
    if (now.includes(head)) return now
    await win.waitForTimeout(250)
  }
  return termText()
}

const statusLog = () => win.evaluate(() => window.__statusLog ?? [])

/** 只取末尾若干条非空行，用于失败时看清现场 */
function tail(text, n = 8) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .slice(-n)
    .join(' ⏎ ')
}

// ---------- 准备：切到 DOM 渲染器 + 挂状态记录器 ----------
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
  { timeout: 10000 }
)
// 设置现在存在主进程，改完要等它落盘再 reload，否则会读到旧值
const originalSettings = await win.evaluate(() => window.api.getSettings())
await win.evaluate(async () => {
  const cur = (await window.api.getSettings()) ?? {}
  await window.api.setSettings({ ...cur, ligatures: true })
  // 布局会持久化，上一个脚本留下的标签会被恢复出来，干扰「本次操作的终端是哪个」
  await window.api.setLayout({ tabs: [] })
})
await win.reload()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(
  () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
  { timeout: 10000 }
)

// 重连只要约 1 秒，靠轮询去抓「重连中」必然漏。改成记录每一次状态推送，
// 断言打在记录上，与采样时机无关。
await win.evaluate(() => {
  window.__statusLog = []
  window.api.onStatus((e) => window.__statusLog.push({ ...e, t: Date.now() }))

  // 状态条从出现到消失只有一秒出头，靠外部轮询必然抓不稳。
  // 交给页面自己盯着 DOM 变化，出现/消失各记一笔。
  window.__barLog = []
  window.__lastBar = false
  new MutationObserver(() => {
    const has = !!document.querySelector('.reconnect-bar')
    if (has !== window.__lastBar) {
      window.__lastBar = has
      window.__barLog.push({ has, t: Date.now() })
    }
  }).observe(document.body, { childList: true, subtree: true })
})

const barLog = () => win.evaluate(() => window.__barLog ?? [])

check(
  '终端文本可读（DOM 渲染器就绪）',
  await win.evaluate(() => document.querySelectorAll('.xterm-rows').length > 0)
)

// ---------- 连接设备 ----------
const deviceCount = await win.locator('.device').count()
if (!deviceCount) {
  console.log('没有已保存设备，无法验证。')
  await app.close()
  process.exit(1)
}
await win.locator('.device .device-name').first().dblclick()
try {
  await win.waitForFunction(
    () => document.querySelectorAll('.terminal-container').length >= 2,
    { timeout: 25000 }
  )
} catch {
  check('SSH 连接建立', false, '超时')
  await app.close()
  process.exit(1)
}
await win.waitForTimeout(2000)
check('SSH 连接建立', true)

// ---------- 断线前：进入可辨识目录 ----------
await termRun('cd /tmp && rm -f /tmp/dox-cwd-marker /root/dox-cwd-marker')
const beforeDrop = await termRun('pwd')
check('断线前已在 /tmp（cwd 跟踪生效）', hasOutputLine(beforeDrop, '/tmp'), tail(beforeDrop, 4))

const logBefore = (await statusLog()).length

// ---------- 制造断线 ----------
await termRun('kill -9 $PPID', 250)

// 尽早就绪的截图（状态条可能已经消失，这一步只是留档，不参与断言）
await win.waitForTimeout(300)
await win.screenshot({ path: 'shots/40-reconnecting.png' })

// 等重连落定
let recovered = false
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(500)
  const log = await statusLog()
  if (log.some((e) => e.status === 'connected' && e.reconnected)) {
    recovered = true
    break
  }
}

const log = (await statusLog()).slice(logBefore)
const kinds = log.map((e) => e.status).join(' → ')
check('主进程推送了 reconnecting 状态', log.some((e) => e.status === 'reconnecting'), kinds)
const bars = await barLog()
check(
  '重连期间界面出现状态条，恢复后自动消失',
  bars.some((b) => b.has) && bars[bars.length - 1]?.has === false,
  bars.map((b) => (b.has ? '出现' : '消失')).join(' → ') || '(从未出现)'
)
check('重连成功且带 reconnected 标记', recovered, kinds)
check(
  '重连次数从 1 开始计时',
  log.find((e) => e.status === 'reconnecting')?.attempt === 1,
  String(log.find((e) => e.status === 'reconnecting')?.attempt)
)
check('状态点回到已连接', (await win.evaluate(() =>
  document.querySelector('.tab.active .status-dot')?.className
))?.includes('connected'))
await win.screenshot({ path: 'shots/41-reconnected.png' })

const afterReconnect = await termText()
check(
  '终端里留下「已重新连接」分隔行',
  afterReconnect.includes('已重新连接'),
  tail(afterReconnect, 6)
)
check('分隔行带上了断线原因', afterReconnect.includes('连接已断开'), tail(afterReconnect, 8))
check(
  '断线前的输出被保留（未清屏）',
  afterReconnect.includes('dox-cwd-marker') || afterReconnect.includes('kill -9'),
  tail(afterReconnect, 8)
)

// ---------- cwd 是否恢复 ----------
// 用相对路径建文件：cwd 恢复到 /tmp 则文件落在 /tmp，否则落在 home。
const afterCwd = await termRun('touch dox-cwd-marker && pwd', 1200)
check('重连后回到断线前的目录 /tmp', hasOutputLine(afterCwd, '/tmp'), tail(afterCwd, 5))

await win.locator('button:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
await win.waitForTimeout(800)
const inHome = await win
  .locator('.explorer .row')
  .filter({ hasText: 'dox-cwd-marker' })
  .count()
check('home 目录下没有该文件（确认确实在 /tmp）', inHome === 0)

// ---------- 用户主动 exit 不应触发重连 ----------
const logBeforeExit = (await statusLog()).length
await termRun('exit', 1500)
await win.waitForTimeout(2500)
const exitLog = (await statusLog()).slice(logBeforeExit)
check(
  '敲 exit 退出后不会自动重连（否则用户永远退不出去）',
  !exitLog.some((e) => e.status === 'reconnecting'),
  exitLog.map((e) => e.status).join(' → ') || '(无状态事件)'
)

// ---------- 安全断言：认证失败绝不重连 ----------
// 反复用错误的密码重试会触发服务器 fail2ban / 账户锁定，
// 把「重连」变成「封号」。这是整条重连逻辑里最不能出错的一条。
const logBeforeAuth = (await statusLog()).length
await win.locator('.add-btn').click()
await win.waitForTimeout(500)
await win.locator('input[placeholder^="192.168"]').fill('example.com')
await win.locator('input[placeholder="root"]').fill('root')
await win.locator('input[placeholder="登录密码"]').fill('__definitely_wrong_password__')
await win.locator('button:has-text("仅连接")').click()

// 给足时间：若误触发重连，第一轮退避（1s）早该到了
await win.waitForTimeout(8000)

const authLog = (await statusLog()).slice(logBeforeAuth)
check(
  '认证失败不会触发任何重连尝试',
  !authLog.some((e) => e.status === 'reconnecting'),
  authLog.map((e) => e.status).join(' → ') || '(无状态事件)'
)
check(
  '认证失败在界面上可见（不是静默无反应）',
  (await win.locator('.tab-placeholder').filter({ hasText: '连接失败' }).count()) > 0,
  (await win.locator('.tab-placeholder').last().textContent().catch(() => '')) ?? ''
)

// 还原为测试而打开的设置，别把它留在用户机器上
await win.evaluate(async (orig) => {
  if (orig) await window.api.setSettings(orig)
}, originalSettings)

console.log('\n渲染进程报错:', errors.length ? errors.slice(0, 5) : '无')
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')

await app.close()

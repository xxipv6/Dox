/**
 * 嵌套容器（容器里的容器）端到端，全程走本机路径：
 *  本地终端 → 侧栏进 dox-sshd-test（它是 dind，肚子里有 inner）→
 *  容器分区列出**嵌套容器** inner（docker exec 链）→ 右键进入 inner →
 *  echo 验证真在嵌套容器里 → 嵌套标签的容器分区显示「没有 docker/podman」
 *  （inner 是净 alpine，没有内层运行时）→ 嵌套标签没有 SFTP/进程管理入口。
 *
 * 用法：node scripts/verify-nested-container.mjs
 * 前置：npm run build；本机 docker 里 dox-sshd-test 在跑、inner 已 start
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })
const OUTER = 'dox-sshd-test'
const INNER = 'inner'

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

/** 等终端出现提示符再敲键盘（容器 exec 通道就绪前输入会被丢） */
async function waitPrompt(timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const text = await win.evaluate(
      () => document.querySelector('.tab-content:not([style*="display: none"]) .xterm-rows')?.textContent ?? ''
    )
    if (/[#$]\s*$/m.test(text.trimEnd())) return true
    await win.waitForTimeout(400)
  }
  return false
}

/**
 * 当前可见终端的所有行。
 * 注意：xterm 的行是一个个 div，textContent 拼接时**不会**补换行 ——
 * 必须逐行元素取 textContent，否则「独占一行」这种判断永远是假的。
 */
const termLines = () =>
  win.evaluate(() =>
    [
      ...document.querySelectorAll('.tab-content:not([style*="display: none"]) .xterm-rows > div')
    ].map((d) => d.textContent.trim())
  )

// ---- 本地终端 → 侧栏进外层容器 ----
const ctrHead = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await ctrHead.getAttribute('aria-expanded')) === 'false') {
  await ctrHead.click()
  await win.waitForTimeout(1500)
}
const outerRow = win.locator('.container').filter({ hasText: OUTER }).first()
await outerRow.waitFor({ timeout: 15000 })
await outerRow.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
check('进入外层容器（dind）', await waitPrompt())

// ---- 容器分区现在应该列出嵌套容器 inner ----
await win.locator('.sidebar button[title="刷新容器列表"]').click()
await win.waitForTimeout(2500)
const nestedRow = win.locator('.container').filter({ hasText: INNER }).first()
let nestedListed = false
try {
  await nestedRow.waitFor({ timeout: 8000 })
  nestedListed = true
} catch { /* 没列出来 */ }
check('容器标签下列出嵌套容器 inner', nestedListed)
await win.screenshot({ path: 'shots/86-nested-list.png' })

// ---- 右键进入嵌套容器 inner ----
await nestedRow.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
const nestedUp = await waitPrompt()
// 失败诊断：哪个标签活跃、pane 占位区/复活层说什么、终端挂没挂载
const diag = await win.evaluate(() => {
  const tabs = [...document.querySelectorAll('.tab-content')].map((t) => ({
    visible: !t.getAttribute('style')?.includes('display: none'),
    hasTerm: !!t.querySelector('.terminal-container'),
    placeholder: t.querySelector('.tab-placeholder')?.textContent.trim() ?? '',
    revive: t.querySelector('.pane-revive')?.textContent.trim() ?? ''
  }))
  return JSON.stringify(tabs)
})
console.log('  （tabs:', diag, ')')
check('进入嵌套容器（提示符出现）', nestedUp)
// 标题应体现嵌套链
const tabTitles = await win.evaluate(() =>
  [...document.querySelectorAll('.tab .tab-title')].map((e) => e.textContent.trim())
)
check('嵌套标签标题带外层链（dox-sshd-test ▸ inner）', tabTitles.some((t) => t.includes('▸')), tabTitles.join(' | '))

// 敲 echo：标记独占一行才算真执行了（回显的那行是 `echo …` 本身）。
// 先点一下终端拿焦点 —— 刚开的新标签焦点可能还在右键菜单的残影上
await win.locator('.terminal-container:visible').first().click()
await win.waitForTimeout(300)
await win.keyboard.type('echo NESTED_OK_42\r')
// 两层 docker exec 链，回显多一跳延迟，多等几拍
let echoOk = false
for (let i = 0; i < 10 && !echoOk; i++) {
  await win.waitForTimeout(600)
  echoOk = (await termLines()).some((l) => l === 'NESTED_OK_42')
}
if (!echoOk) {
  const tail = (await termLines()).slice(-6).join(' | ')
  console.log('  （可见终端尾部:', tail, ')')
}
check('嵌套容器里 echo 真执行', echoOk)
await win.screenshot({ path: 'shots/87-nested-shell.png' })

// ---- 嵌套标签（inner 里）的容器分区：inner 有 docker CLI 但没起 daemon ----
// → 友好归类文案（「守护进程未运行」），原始 socket 报错折叠进「详细信息」
await win.locator('.sidebar button[title="刷新容器列表"]').click()
await win.waitForTimeout(2500)
const hintText = await win.evaluate(
  () => [...document.querySelectorAll('.sidebar .empty-hint')].map((e) => e.childNodes[0]?.textContent?.trim() ?? e.textContent.trim()).join(' | ')
)
check(
  'inner（daemon 未运行）显示友好归类文案',
  hintText.includes('守护进程未运行'),
  hintText.slice(0, 160)
)
const detailText = await win.evaluate(
  () => document.querySelector('.sidebar .err-detail pre')?.textContent ?? ''
)
check('原始报错折叠进「详细信息」', /docker\.sock/.test(detailText), detailText.slice(0, 120))

// ---- 嵌套标签不开放 agent 依赖面：SFTP 按钮与右键「进程管理」都不该出现 ----
const sftpBtn = await win.locator('button.bar-btn:has-text("SFTP")').count()
check('嵌套标签没有 SFTP 按钮', sftpBtn === 0)
await win.locator('.terminal-container:visible').first().click({ button: 'right' })
await win.waitForTimeout(400)
const procMenuCount = await win.locator('.context-menu button', { hasText: '性能监控' }).count()
check('嵌套标签右键没有「性能监控」', procMenuCount === 0)
await win.keyboard.press('Escape')

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

/**
 * 本机容器 agent（不经 SSH 的 LOCAL 分支）端到端：
 *  本机起一个 alpine 容器 → 本地终端标签下侧栏列容器 → 进入 →
 *  UI 安装助手（本机 docker cp，无 SSH）→ agentCall exec 回显 →
 *  procList（agent ps_list 含 sleep 3600）→ 右键「进程管理」面板 →
 *  SFTP 面板列出容器根目录 → 清理容器。
 *
 * 用法：node scripts/verify-local-container-agent.mjs
 * 前置：npm run build && node scripts/build-agent.mjs；本机 docker 可用
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'

const NAME = 'dox-local-verify'
mkdirShots()
function mkdirShots() {
  try { execFileSync('mkdir', ['-p', 'shots']) } catch { /* */ }
}

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// 夹具：本机 alpine 容器（重建干净）
try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* 不在 */ }
execFileSync('docker', ['run', '-d', '--name', NAME, 'alpine', 'sleep', '3600'], { stdio: 'ignore' })
console.log('  夹具就绪')

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

// 本地终端标签是默认页（布局空时自动开一个）。侧栏「容器」列出本机容器
const ctrHead = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await ctrHead.getAttribute('aria-expanded')) === 'false') {
  await ctrHead.click()
  await win.waitForTimeout(1500)
}
const row = win.locator('.container').filter({ hasText: NAME }).first()
await row.waitFor({ timeout: 15000 })
check('本机容器出现在侧栏', true)
await row.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
await win.waitForTimeout(3000)

// UI 安装助手（本机 docker cp 直拷，全程无 SSH）
const agentHead = win.locator('.sidebar .section-head', { hasText: '助手' })
if ((await agentHead.getAttribute('aria-expanded')) === 'false') {
  await agentHead.click()
  await win.waitForTimeout(800)
}
const installBtn = win.locator('button', { hasText: `安装到容器 ${NAME}` })
check('本机容器有安装入口', (await installBtn.count()) === 1)
await installBtn.click()
let installOk = false
try {
  await win.locator('.sidebar .agent-ok', { hasText: '已安装' }).waitFor({ timeout: 30000 })
  installOk = true
} catch { /* 超时 */ }
check('本机容器助手安装成功（本机 docker cp）', installOk)

// IPC 层：agentCall exec + procList 走本机通道
const echo = await win.evaluate(async (name) => {
  return window.api.agentCall('local', name, 'exec', { argv: ['echo', 'local-hi'] })
}, NAME)
check('本机通道 exec 回显', echo.exit_code === 0 && echo.stdout.trim() === 'local-hi', JSON.stringify(echo))

const pl = await win.evaluate(async (name) => window.api.procList('local', name), NAME)
check(
  'procList 本机容器（agent ps_list 含主进程）',
  pl.via === 'agent' && pl.processes.some((p) => p.command.includes('sleep 3600')),
  `via=${pl.via} cmds=${JSON.stringify(pl.processes.map((p) => p.command)).slice(0, 120)}`
)

// 右键 → 进程管理 面板
await win.locator('.terminal-container:visible').first().click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu button', { hasText: '进程管理' }).click()
await win.locator('.proc-panel').waitFor({ timeout: 5000 })
await win.waitForTimeout(2000)
check(
  '进程面板列出本机容器进程',
  (await win.locator('.proc-panel .row', { hasText: 'sleep 3600' }).count()) >= 1
)
await win.screenshot({ path: 'shots/84-local-container-proc.png' })
await win.locator('.proc-panel button[title="关闭"]').click()

// SFTP 面板（本机容器文件，经容器助手）
await win.locator('button.bar-btn:has-text("SFTP")').click()
await win.waitForTimeout(3000)
const listText = await win.evaluate(
  () => [...document.querySelectorAll('.explorer .file-name')].map((e) => e.textContent.trim()).join(',')
)
check('文件面板列出本机容器根目录', /\bbin\b/.test(listText) && /\betc\b/.test(listText), listText.slice(0, 120))
await win.screenshot({ path: 'shots/85-local-container-fs.png' })

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* 清理尽力而为 */ }

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

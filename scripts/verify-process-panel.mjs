/**
 * 进程管理面板端到端（UI）：
 *  SSH 标签右键 → 进程管理（宿主无 agent → fallback-ps 退化模式，列表非空）→ 关闭 →
 *  进 inner 容器标签 → 装容器助手 → 容器标签右键 → 进程管理（agent 模式）→
 *  过滤「sleep 300」→ 行内结束 → 确认条 TERM → 进程从容器里消失。
 *
 * 用法：node scripts/verify-process-panel.mjs [host] [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs；dind + inner 在跑
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'
const INNER = 'inner'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const ssh = new Client()
await new Promise((res, rej) => {
  ssh.on('ready', res).on('error', rej).connect({ host, port, username: user, password, readyTimeout: 10000 })
})
const remoteExec = (c) =>
  new Promise((res, rej) => {
    ssh.exec(c, (e, s) => {
      if (e) return rej(e)
      let o = ''
      s.on('data', (d) => (o += d))
      s.stderr.on('data', () => {})
      s.on('close', (code) => (code === 0 ? res(o) : rej(new Error(`${c} -> ${code}`))))
    })
  })
const ctrExec = (c) => remoteExec(`docker exec ${INNER} sh -c '${c.replace(/'/g, `'\\''`)}'`)

// 夹具：inner 干净（未装助手）；宿主也不装（验证退化路径）
await remoteExec(`docker start ${INNER} 2>/dev/null || docker run -d --name ${INNER} alpine sleep 3600`)
await remoteExec(`docker exec ${INNER} sh -c "rm -f /tmp/dox-agent; true"`)
await remoteExec('rm -rf ~/.dox; true').catch(() => {})
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
await win.waitForTimeout(2000)

// ---- SSH 连接 ----
await win.locator('button[title="添加设备"]').click()
await win.waitForTimeout(400)
await win.locator('input[placeholder^="192.168"]').fill(host)
await win.locator('input.port').fill(String(port))
await win.locator('input[placeholder="root"]').fill(user)
await win.locator('input[placeholder="登录密码"]').fill(password)
await win.locator('button:has-text("仅连接")').click()
for (let i = 0; i < 8; i++) {
  await win.waitForTimeout(1000)
  const hk = await win.evaluate(() =>
    [...document.querySelectorAll('.dialog-header')].map((e) => e.textContent.trim()).some((t) => t.includes('主机'))
  )
  if (hk) { await win.locator('button:has-text("信任并保存")').click(); break }
}
await win.locator('.terminal-container:visible').first().waitFor({ timeout: 20000 })
await win.waitForTimeout(1500)
await win.keyboard.press('Escape')

// ---- 宿主机进程面板（无 agent → fallback-ps 退化）----
await win.locator('.terminal-container:visible').first().click({ button: 'right' })
await win.waitForTimeout(400)
const menuProc = win.locator('.context-menu button', { hasText: '进程管理' })
check('右键菜单有「进程管理」', (await menuProc.count()) === 1)
await menuProc.click()
await win.locator('.proc-panel').waitFor({ timeout: 5000 })
// fallback-ps 等 ps 命令跑完
await win.waitForTimeout(2500)
const hostRows = await win.locator('.proc-panel .row').count()
check('宿主进程列表非空（退化 ps）', hostRows > 3, `rows=${hostRows}`)
check('显示退化模式标记', (await win.locator('.proc-panel .via-note').count()) === 1)
await win.screenshot({ path: 'shots/80-proc-panel-host.png' })
await win.locator('.proc-panel button[title="关闭"]').click()
await win.waitForTimeout(400)

// ---- 进容器 + 装容器助手 ----
const ctrHead = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await ctrHead.getAttribute('aria-expanded')) === 'false') {
  await ctrHead.click()
  await win.waitForTimeout(1500)
}
const row = win.locator('.container').filter({ hasText: INNER }).first()
await row.waitFor({ timeout: 15000 })
await row.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
await win.waitForTimeout(3000)

const agentHead = win.locator('.sidebar .section-head', { hasText: '助手' })
if ((await agentHead.getAttribute('aria-expanded')) === 'false') {
  await agentHead.click()
  await win.waitForTimeout(1000)
}
await win.locator('button', { hasText: `安装到容器 ${INNER}` }).click()
let installOk = false
try {
  await win.locator('.sidebar .agent-ok', { hasText: '已安装' }).waitFor({ timeout: 30000 })
  installOk = true
} catch { /* 超时 */ }
check('容器助手安装成功', installOk)

// ---- 容器里起个靶子进程 ----
await remoteExec(`docker exec -d ${INNER} sleep 300`)

// ---- 容器标签右键 → 进程管理（agent 模式）----
await win.locator('.terminal-container:visible').first().click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu button', { hasText: '进程管理' }).click()
await win.locator('.proc-panel').waitFor({ timeout: 5000 })
// ps_list 两次采样（默认 300ms）+ 往返
await win.waitForTimeout(2500)
const ctrRows = await win.locator('.proc-panel .row').count()
check('容器进程列表非空（agent ps_list）', ctrRows >= 2, `rows=${ctrRows}`)
check('agent 模式无退化标记', (await win.locator('.proc-panel .via-note').count()) === 0)
check('列表含容器主进程 sleep 3600', (await win.locator('.proc-panel .row', { hasText: 'sleep 3600' }).count()) >= 1)

// 过滤
await win.locator('.proc-panel .filter-row input').fill('sleep 300')
await win.waitForTimeout(400)
const filteredRows = await win.locator('.proc-panel .row').count()
check('过滤后只剩 sleep 300', filteredRows === 1, `rows=${filteredRows}`)
await win.screenshot({ path: 'shots/81-proc-panel-container.png' })

// 结束：行内「结束」→ 确认条 → TERM
await win.locator('.proc-panel .row .kill-btn', { hasText: '结束' }).first().click()
await win.locator('.proc-panel .confirm-bar').waitFor({ timeout: 3000 })
await win.locator('.proc-panel .confirm-bar .kill-btn.danger', { hasText: '结束' }).click()
await win.waitForTimeout(3000)
// busybox ps 默认只显示 comm 不带参数，必须 -o args 才能匹配 'sleep 300'
const gone = await ctrExec(`ps -o args | grep 'sleep 300' | grep -v grep || echo GONE`)
check('TERM 后容器里进程消失', gone.includes('GONE'), gone)
check('面板里该行也消失', (await win.locator('.proc-panel .row').count()) === 0)

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
ssh.end()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

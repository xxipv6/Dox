/**
 * agent 0.4.0 新协议端到端（IPC 层，不经 UI）：
 *  安装宿主机助手 → agentCall exec（echo / false / 超时 / 缺二进制）→
 *  agentCall 白名单拦截（非白名单方法被拒）→ fs_usage →
 *  procList（via=agent，pid 1 在列）→ procKill 守卫（pid 1 被拒）→
 *  procKill 实战（起 sleep 123 → 列表可见 → TERM 掉 → 消失）→
 *  sftpDiskUsage（宿主 statvfs 扩展）。
 *
 * 用法：node scripts/verify-agent-exec.mjs [host] [port] [user] [password]
 * 前置：npm run build && node scripts/build-agent.mjs；测试机在跑
 */
import { _electron as electron } from 'playwright'
import { Client } from 'ssh2'

const host = process.argv[2] ?? 'localhost'
const port = Number(process.argv[3] ?? 2222)
const user = process.argv[4] ?? 'doxtest'
const password = process.argv[5] ?? 'doxtest123'

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

// 起点：未安装状态
await remoteExec('rm -rf ~/.dox; true').catch(() => {})

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

// 直接经 API 建会话（可能弹指纹确认，并行盯掉）
const connP = win.evaluate(async ({ host, port, user, password }) => {
  return window.api.connect(
    { host, port, username: user, auth: { type: 'password', password } },
    { cols: 80, rows: 24 }
  )
}, { host, port, user, password })
let sid = null
for (let i = 0; i < 15 && sid === null; i++) {
  await win.waitForTimeout(800)
  const trustBtn = win.locator('button:has-text("信任并保存")')
  if (await trustBtn.count()) await trustBtn.first().click().catch(() => {})
  sid = await Promise.race([connP, Promise.resolve(null)])
}
check('会话已建立', !!sid)

// 安装宿主机助手（opt-in 的显式调用，等同 UI 点按钮）
const st = await win.evaluate((id) => window.api.agentInstall(id), sid)
check('宿主机助手安装成功（0.4.0）', st.installed && st.version === '0.4.0', JSON.stringify(st))

const call = (method, params) =>
  win.evaluate(({ id, method, params }) => window.api.agentCall(id, undefined, method, params), { id: sid, method, params })

// ---- exec ----
const echo = await call('exec', { argv: ['echo', 'hi-dox'] })
check('exec echo 回显', echo.exit_code === 0 && echo.stdout.trim() === 'hi-dox', JSON.stringify(echo))

const failRun = await call('exec', { argv: ['false'] })
check('exec false 回退出码 1', failRun.exit_code === 1, JSON.stringify(failRun))

const slow = await call('exec', { argv: ['sh', '-c', 'sleep 5'], timeout_ms: 1000 })
check('exec 超时守卫（1s 截停 sleep 5）', slow.timed_out === true, JSON.stringify(slow))

let missingErr = ''
try {
  await call('exec', { argv: ['dox-nonexistent-binary-xyz'] })
} catch (e) {
  missingErr = String(e)
}
check('exec 缺二进制报错（协议错误，非崩溃）', missingErr.length > 0, missingErr.slice(0, 120))

let emptyErr = ''
try {
  await call('exec', { argv: [] })
} catch (e) {
  emptyErr = String(e)
}
check('exec 空 argv 拒绝', emptyErr.length > 0)

// ---- 白名单 ----
let wlErr = ''
try {
  await call('watch_ports', { interval_ms: 1000 })
} catch (e) {
  wlErr = String(e)
}
check('非白名单方法被主进程拦截', wlErr.includes('白名单'), wlErr.slice(0, 120))

// ---- fs_usage ----
const usage = await call('fs_usage', { path: '/' })
check('fs_usage 返回总量/可用', usage.total > 0 && usage.avail > 0 && usage.used >= 0, JSON.stringify(usage))

// ---- procList / procKill ----
const pl = await win.evaluate((id) => window.api.procList(id), sid)
check('procList via=agent 且非空', pl.via === 'agent' && pl.processes.length > 0, `via=${pl.via} n=${pl.processes.length}`)
check('procList 含 pid 1', pl.processes.some((p) => p.pid === 1))

let guardErr = ''
try {
  await win.evaluate((id) => window.api.procKill(id, 1, 15), sid)
} catch (e) {
  guardErr = String(e)
}
check('procKill 拒绝 pid 1', guardErr.length > 0)

// setsid 脱离会话进程组：裸 `sleep &` 会随 exec 通道关闭被一起收掉
await remoteExec('setsid sleep 123 </dev/null >/dev/null 2>&1 & echo ok')
await win.waitForTimeout(500)
const pl2 = await win.evaluate((id) => window.api.procList(id), sid)
const victim = pl2.processes.find((p) => p.command.includes('sleep 123'))
check('sleep 123 出现在进程列表', !!victim, JSON.stringify(pl2.processes.map((p) => p.command).slice(0, 8)))
if (victim) {
  await win.evaluate(({ id, pid }) => window.api.procKill(id, pid, 15), { id: sid, pid: victim.pid })
  await win.waitForTimeout(800)
  const pl3 = await win.evaluate((id) => window.api.procList(id), sid)
  check('TERM 后进程消失', !pl3.processes.some((p) => p.command.includes('sleep 123')))
}

// ---- 宿主磁盘用量（statvfs 扩展，不经 agent）----
const du = await win.evaluate((id) => window.api.sftpDiskUsage(id, '/'), sid)
check('sftpDiskUsage 宿主（statvfs）', du !== null && du.total > 0 && du.used >= 0, JSON.stringify(du))

// 清理：测试机回到未安装状态
// 清理：杀掉可能残留的靶子进程，测试机回到未安装状态
await remoteExec('pkill -f "sleep 123" 2>/dev/null; true').catch(() => {})
await win.evaluate((id) => window.api.disconnect(id), sid)
await remoteExec('rm -rf ~/.dox; true').catch(() => {})
ssh.end()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

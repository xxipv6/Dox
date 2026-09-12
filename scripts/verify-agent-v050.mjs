/**
 * agent 0.5.0 新能力的端到端验证（全程本机，不经 SSH）：
 *  本机 alpine 容器 → UI 安装助手（0.5.0）→
 *  ① fs_du：/ 的直接子项按大小排序返回 →
 *  ② 续传协议位：fs_write_begin 重入返回 existing_size，偏移补齐后 commit 内容正确 →
 *  ③ watch_stats top_procs：容器里跑 CPU 燃烧器，帧里点名它（≥10%）→
 *  ④ 本机容器右键「性能监控」→ 概览页每核格子 + 「谁在吃 CPU」点名 →
 *  ⑤ SFTP 面板点用量条展开 du 分解。
 *
 * 用法：node scripts/verify-agent-v050.mjs
 * 前置：npm run build && node scripts/build-agent.mjs；本机 docker 可用
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const NAME = 'dox-v050-verify'
mkdirSync('shots', { recursive: true })

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

// ---- 本地终端标签 → 侧栏进容器 → 装助手 ----
const ctrHead = win.locator('.sidebar .section-head', { hasText: '容器' })
if ((await ctrHead.getAttribute('aria-expanded')) === 'false') {
  await ctrHead.click()
  await win.waitForTimeout(1500)
}
const row = win.locator('.container').filter({ hasText: NAME }).first()
await row.waitFor({ timeout: 15000 })
await row.click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu .menu-item').filter({ hasText: '进入' }).first().click()
await win.waitForTimeout(3000)

const agentHead = win.locator('.sidebar .section-head', { hasText: '助手' })
if ((await agentHead.getAttribute('aria-expanded')) === 'false') {
  await agentHead.click()
  await win.waitForTimeout(800)
}
await win.locator('button', { hasText: `安装到容器 ${NAME}` }).click()
let installOk = false
try {
  await win.locator('.sidebar .agent-ok', { hasText: '已安装' }).waitFor({ timeout: 30000 })
  installOk = true
} catch { /* 超时 */ }
check('助手 0.5.0 安装成功', installOk)

const call = (method, params) =>
  win.evaluate(
    ([m, p, name]) => window.api.agentCall('local', name, m, p),
    [method, params, NAME]
  )

// ---- ① fs_du：/ 的直接子项按大小降序 ----
const du = await call('fs_du', { path: '/' })
const duNames = (du.entries ?? []).map((e) => e.name)
const duSorted = (du.entries ?? []).every((e, i, a) => i === 0 || a[i - 1].size >= e.size)
check(
  'fs_du 返回 / 的子项且按大小降序',
  duNames.includes('usr') && duNames.includes('bin') && duSorted && du.truncated === false,
  JSON.stringify(du).slice(0, 200)
)

// ---- ② 续传协议位：begin → 写一半 → 再 begin（existing_size）→ 补齐 → commit ----
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const begin1 = await call('fs_write_begin', { path: '/tmp/resume.bin' })
await call('fs_write_chunk', { tmp: begin1.tmp, offset: 0, data: b64('partial-') })
const begin2 = await call('fs_write_begin', { path: '/tmp/resume.bin' })
check(
  '重入 fs_write_begin 报出已写字节（existing_size=8，同一 tmp）',
  begin2.tmp === begin1.tmp && begin2.existing_size === 8,
  JSON.stringify({ begin1, begin2 })
)
await call('fs_write_chunk', { tmp: begin2.tmp, offset: 8, data: b64('content') })
await call('fs_write_commit', { tmp: begin2.tmp, path: '/tmp/resume.bin' })
const cat = await call('exec', { argv: ['cat', '/tmp/resume.bin'] })
check('续传补齐后 commit 内容正确', cat.stdout === 'partial-content', JSON.stringify(cat))

// ---- ③ top_procs：起 CPU 燃烧器，watch_stats 帧里点名 ----
await call('exec', { argv: ['sh', '-c', 'while :; do :; done >/dev/null 2>&1 &'] })
const topProc = await win.evaluate(async (name) => {
  const frames = []
  const off = window.api.onAgentStats((id, ctr, data) => {
    if (ctr === name && data.event === 'stats') frames.push(data)
  })
  try {
    await window.api.agentWatchStats('local', name)
    const start = Date.now()
    while (Date.now() - start < 20000) {
      await new Promise((r) => setTimeout(r, 500))
      const hit = frames.find((f) => (f.top_procs?.[0]?.cpu_percent ?? 0) >= 10)
      if (hit) return hit.top_procs[0]
    }
    return null
  } finally {
    off()
    void window.api.agentUnwatchStats('local', name)
  }
}, NAME)
check(
  'watch_stats 帧点名 CPU 燃烧器（top_procs[0] ≥10%）',
  !!topProc && /sh|while/.test(topProc.command),
  JSON.stringify(topProc)
)

// ---- ④ 本机容器性能监控概览（终端状态条已移除，概览页是 watch_stats 的落点）----
await win.locator('.terminal-container:visible').first().click({ button: 'right' })
await win.waitForTimeout(400)
await win.locator('.context-menu button', { hasText: '性能监控' }).click()
await win.locator('.mon-panel').waitFor({ timeout: 5000 })
let coreCount = 0
for (let k = 0; k < 15 && coreCount === 0; k++) {
  await win.waitForTimeout(1000)
  coreCount = await win.locator('.mon-panel .core-box').count()
}
check('本机容器性能监控概览出现（每核格子）', coreCount > 0, `cores=${coreCount}`)
const ovText = (await win.locator('.mon-panel .page:visible').textContent()) ?? ''
check('概览点名 top 进程（谁在吃 CPU）', ovText.includes('谁在吃 CPU'), ovText.slice(0, 200))
await win.screenshot({ path: 'shots/88-v050-topproc.png' })
await win.locator('.mon-panel button[title="关闭"]').click()

// ---- ⑤ SFTP 面板：点用量条展开 du 分解 ----
await win.locator('button.bar-btn:has-text("SFTP")').click()
await win.waitForTimeout(3000)
const usageBar = win.locator('.explorer .usage-bar')
let duPanelOk = false
try {
  await usageBar.waitFor({ timeout: 10000 })
  await usageBar.click()
  await win.locator('.explorer .du-panel .du-row').first().waitFor({ timeout: 10000 })
  duPanelOk = true
} catch { /* 超时 */ }
check('用量条点开 du 分解面板', duPanelOk)
await win.screenshot({ path: 'shots/89-v050-du.png' })

// 收尾：杀掉燃烧器（尽力而为）
await call('exec', { argv: ['sh', '-c', 'pkill -f "while :; do" 2>/dev/null; true'] }).catch(() => {})

await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()
try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }) } catch { /* 清理尽力而为 */ }

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

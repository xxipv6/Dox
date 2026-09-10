/**
 * 会话布局持久化与启动恢复验证。
 *
 * A. 真实往返：连上设备 + 再开一个本地终端 → 退出 → 重启 → 布局应原样回来，
 *    且已保存设备自动连上。同时确认快照真的落到了主进程的 dox-layout.json。
 * B. 未保存的临时连接：经 IPC 注入快照（这条路径没法用真实操作造出来 ——
 *    临时连接需要有效密码，测试机上我们不该存密码）。
 *    断言恢复成占位标签、点击后弹窗被正确预填、且不会自作主张去连接。
 *
 * 用法：node scripts/verify-layout.mjs
 * 前置：npm run build
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('shots', { recursive: true })

const LAYOUT_FILE = join(process.env.APPDATA ?? '', 'dox', 'dox-layout.json')

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const rendererErrors = []

async function boot() {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  win.on('dialog', (d) => d.accept())
  win.on('console', (m) => {
    if (m.type() === 'error') rendererErrors.push(m.text())
  })
  win.on('pageerror', (e) => rendererErrors.push(`PAGEERROR ${e.message}`))
  await win.waitForLoadState('domcontentloaded')
  // 等标签栏出现，而不是等终端容器：恢复出的「未保存会话」占位标签
  // 本来就没有终端，用后者会误判成启动失败。
  await win.waitForFunction(() => document.querySelectorAll('.tab').length > 0, undefined, {
    timeout: 25000
  })
  return { app, win }
}

const tabTitles = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.tab .tab-title')].map((e) => e.textContent?.trim() ?? '')
  )

const readLayoutFile = () => {
  try {
    return existsSync(LAYOUT_FILE) ? readFileSync(LAYOUT_FILE, 'utf8') : null
  } catch {
    return null
  }
}

// ---------- 起点：清掉旧快照，从干净状态开始 ----------
console.log('A. 布局往返')
let { app, win } = await boot()
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
await app.close()

;({ app, win } = await boot())
const initial = await tabTitles(win)
check('无快照时只开默认本地终端', initial.length === 1, JSON.stringify(initial))

await win.locator('.device .device-name').first().dblclick()
await win.waitForFunction(
  () => document.querySelectorAll('.terminal-container').length >= 2,
  { timeout: 25000 }
)
await win.waitForTimeout(1500)

// 再开一个本地终端，制造「多标签」布局
await win.locator('.tab-new').click()
await win.waitForTimeout(1500)

const before = await tabTitles(win)
check('退出前有 3 个标签', before.length === 3, JSON.stringify(before))

// 等防抖落盘
await win.waitForTimeout(1500)
const savedRaw = readLayoutFile()
check('布局快照已落到主进程存储文件', !!savedRaw, LAYOUT_FILE)

// electron-store 会把数据包在顶层键下面，取 layout.tabs
const savedSnap = JSON.parse(savedRaw ?? '{}')
const savedTabs = savedSnap.layout?.tabs ?? []
check(
  '快照记录了已保存设备的 id（重启才能自动连）',
  savedTabs.some((t) => t.savedSessionId),
  JSON.stringify(savedTabs.map((t) => t.savedSessionId ?? t.kind))
)
const leaked = /password|passphrase|encrypted/i.exec(savedRaw ?? '')
check('快照里不含任何密码字段', !leaked, leaked ? `发现字段：${leaked[0]}` : '')

await app.close()

;({ app, win } = await boot())
await win.waitForTimeout(5000)

const after = await tabTitles(win)
check('重启后标签数量与顺序一致', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))
check(
  '已保存设备自动重连成功',
  await win.evaluate(
    () =>
      document.querySelectorAll('.terminal-container').length >= 2 &&
      !!document.querySelector('.tab.active .status-dot.connected')
  )
)
check(
  '没有多出多余的默认本地终端',
  after.filter((t) => t.startsWith('本地')).length ===
    before.filter((t) => t.startsWith('本地')).length,
  JSON.stringify(after)
)
await win.screenshot({ path: 'shots/50-layout-restored.png' })

// ---------- B. 未保存的临时连接 ----------
console.log('\nB. 未保存会话的恢复')
await win.evaluate(() =>
  window.api.setLayout({
    tabs: [
      {
        kind: 'ssh',
        // title 与 username 必须自洽 —— 真实连接时 title 就是 `${username}@${host}`
        title: 'deploy@10.9.9.9',
        split: 'none',
        paneCount: 1,
        active: true,
        host: '10.9.9.9',
        port: 2222,
        username: 'deploy'
      }
    ]
  })
)
await win.reload()
await win.waitForLoadState('domcontentloaded')
// 这里恢复出来的是「未保存」占位标签，本来就没有终端容器，
// 等标签栏出现即可
await win.waitForFunction(() => document.querySelectorAll('.tab').length > 0, undefined, {
  timeout: 15000
})
await win.waitForTimeout(2500)

const resumed = await tabTitles(win)
check(
  '临时连接的标签被恢复出来',
  resumed.some((t) => t.includes('deploy@10.9.9.9')),
  JSON.stringify(resumed)
)
check('恢复成占位提示（未保存的会话）', (await win.locator('.resume-hint').count()) > 0)
check(
  '没有自作主张去连接',
  (await win.evaluate(() => !!document.querySelector('.tab.active .status-dot.connected'))) === false
)
await win.screenshot({ path: 'shots/51-unsaved-placeholder.png' })

// 点「重新连接」→ 弹窗应带出地址，但密码必须是空的
await win.locator('.resume-btn').click()
await win.waitForTimeout(600)
const form = await win.evaluate(() => ({
  host: document.querySelector('input[placeholder^="192.168"]')?.value ?? '',
  port: document.querySelector('input[type="number"]')?.value ?? '',
  username: document.querySelector('input[placeholder="root"]')?.value ?? '',
  password: document.querySelector('input[placeholder="登录密码"]')?.value ?? ''
}))
check('弹窗预填了主机地址', form.host === '10.9.9.9', JSON.stringify(form))
check('弹窗预填了端口', form.port === '2222', form.port)
check('弹窗预填了用户名', form.username === 'deploy', form.username)
check('密码栏为空（绝不从快照回填）', form.password === '', JSON.stringify(form.password))
await win.screenshot({ path: 'shots/52-prefilled-dialog.png' })

// 收尾：清掉测试快照，别影响后续使用
await win.evaluate(() => window.api.setLayout({ tabs: [] }))

console.log('\n渲染进程报错:', rendererErrors.length ? rendererErrors.slice(0, 8) : '无')
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()

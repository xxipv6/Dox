/**
 * 文件夹传输的「全部取消」验证。
 *
 * 用户报的问题：点文件夹的下载按钮，底部进度条一直跑，没有任何办法停下来。
 * 旧根因是文件夹传输会把目录展开成成百上千条任务，取消按钮每条一个，
 * 目录遍历还在继续，取消掉的总被新冒出来的补上。
 *
 * 现在的形态（tar 整流）：文件夹下载是**一条**任务（远端 tar 边打包边发、
 * 本地边收边解），「全部取消」= 关 exec 通道 + 删半截文件。本脚本验：
 * 一条整流任务在传 → 全部取消 → 落定「已取消」→ 不再有动静 → 条目自动消失。
 * （逐文件回退路径的取消语义由 verify-tar-transfer.mjs 阶段 2 覆盖。）
 *
 * 这里驱动真实的「文件夹下载」路径：用 app.evaluate 在主进程里替换掉
 * dialog.showOpenDialog（原生目录选择框 Playwright 点不了），其余全走真代码。
 *
 * 用法：node scripts/verify-folder-cancel.mjs                      # 用第一个已保存设备
 *      node scripts/verify-folder-cancel.mjs <host> [port] [user] [password]  # 仅连接指定主机
 * 前置：npm run build；无参数时需要已保存一个可连接的设备
 *
 * 远端只做：建一个测试目录（若干小文件）、最后删掉它。不安装任何东西。
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mkdirSync('shots', { recursive: true })

/*
 * 目录名带体量标识：上次跑挂留下的旧目录（不同体量）不会骗过
 * 「就绪」检查 —— 看见这个名字才证明本次命令真的跑完了。
 * 100 × 10MB = 1GB。整流传输非常快，25MB 在本机夹具上 1 秒不到就传完，
 * 根本来不及点「全部取消」—— 要验取消，体量必须大到传输能持续几秒。
 */
const DIR = 'dox-many-files-1g'
const FILE_COUNT = 100
const FILE_BYTES = 10485760
const LOCAL_OUT = join(tmpdir(), 'dox-folder-cancel')
rmSync(LOCAL_OUT, { recursive: true, force: true })
mkdirSync(LOCAL_OUT, { recursive: true })

// 单实例锁（CLI 伴侣）下，上次的僵尸实例会让本实例启动即退；只能杀本仓库的 electron
try {
  if (process.platform === 'win32') {
    // Windows 没有 pkill：按可执行路径匹配本仓库的 electron（taskkill /IM 会误杀别的 Electron 应用）
    (await import('node:child_process')).execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { stdio: 'ignore' })
  } else {
    (await import('node:child_process')).execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
  }
} catch { /* 没有正好 */ }
const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const counts = () =>
  win.evaluate(() => {
    const out = { total: 0, active: 0, pending: 0, done: 0, canceled: 0, error: 0 }
    for (const row of document.querySelectorAll('.task')) {
      out.total++
      const s = row.querySelector('.task-status')?.textContent ?? ''
      if (s.includes('传输中')) out.active++
      else if (s.includes('排队中')) out.pending++
      else if (s.includes('完成')) out.done++
      else if (s.includes('已取消')) out.canceled++
      else if (s.includes('失败')) out.error++
    }
    return out
  })

const rows = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.explorer .file-list .row')].map((r) =>
      (r.querySelector('.file-name')?.textContent ?? '').trim()
    )
  )

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

const host = process.argv[2]
const port = Number(process.argv[3] ?? 22)
const user = process.argv[4] ?? 'root'
const password = process.argv[5] ?? ''

if (host) {
  // 仅连接指定主机（不保存设备，不碰真实配置）
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
    if (hk) {
      await win.locator('button:has-text("信任并保存")').click()
      break
    }
  }
  await win.locator('.terminal-container:visible').first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Escape')
} else {
  if (!(await win.locator('.device').count())) {
    console.log('没有已保存设备，也无法验证（可传 host 参数走仅连接）。')
    await app.close()
    process.exit(1)
  }
  await win.locator('.device .device-name').first().dblclick()
}
await win.waitForFunction(
  () => [...document.querySelectorAll('.terminal-container')].some((el) => el.clientWidth > 200),
  undefined,
  { timeout: 25000 }
)
await win.waitForTimeout(2500)

// ---------- 远端造一个有几百个文件的目录 ----------
// 打字要慢且带重试：连接刚建立时焦点/首字符可能被吃（MAINTENANCE 踩坑录）
console.log(`远端造 ${FILE_COUNT} 个小文件…`)
const input = win.locator('.tab-content:visible .xterm-helper-textarea').first()
await win.locator('button:has-text("SFTP")').click()
await win.locator('.explorer .row').first().waitFor({ timeout: 15000 })
const rowsNow = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.explorer .file-list .row')].map((r) =>
      (r.querySelector('.file-name')?.textContent ?? '').trim()
    )
  )
let fixtureReady = false
for (let attempt = 0; attempt < 3 && !fixtureReady; attempt++) {
  await input.click()
  await win.waitForTimeout(600)
  await win.keyboard.type(
    `rm -rf ~/${DIR} && mkdir -p ~/${DIR} && ` +
      `for i in $(seq 1 ${FILE_COUNT}); do head -c ${FILE_BYTES} /dev/zero > ~/${DIR}/f$i.bin; done && echo READY`,
    { delay: 30 }
  )
  await win.keyboard.press('Enter')
  for (let i = 0; i < 20 && !fixtureReady; i++) {
    await win.waitForTimeout(1000)
    await win.locator('.toolbar button[title="刷新"]').click().catch(() => {})
    await win.waitForTimeout(500)
    fixtureReady = (await rowsNow()).includes(DIR)
  }
}
check('远端测试目录已就绪', fixtureReady)

// ---------- 替换掉原生目录选择框 ----------
// Playwright 点不了 Electron 的原生对话框；只替换这一个函数，其余走真代码
await app.evaluate(({ dialog }, dir) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
}, LOCAL_OUT)

// ---------- 点文件夹的下载按钮 ----------
console.log('\n开始下载文件夹…')
const row = win.locator('.explorer .row').filter({ hasText: DIR }).first()
await row.hover()
await row.locator('button[title^="下载文件夹"]').click()

// tar 整流：整个文件夹只有一条任务，等它真的跑起来（字节在涨）
let taskName = ''
let grew = false
let lastTransferred = ''
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(200)
  const t = await win.evaluate(() => {
    const el = [...document.querySelectorAll('.task')].find((x) =>
      (x.querySelector('.task-name')?.textContent ?? '').includes('dox-many-files')
    )
    return el
      ? {
          name: (el.querySelector('.task-name')?.textContent ?? '').trim(),
          status: (el.querySelector('.task-status')?.textContent ?? '').replace(/\s+/g, ' ').trim()
        }
      : null
  })
  if (!t) continue
  taskName = t.name
  if (t.status.startsWith('传输中') && lastTransferred && t.status !== lastTransferred) grew = true
  lastTransferred = t.status
  if (grew) break
}
console.log('任务:', taskName, '|', lastTransferred)
check('文件夹下载是一条整流任务', taskName.includes('整流模式'), taskName)
check('任务确实在传（进度在涨）', grew, lastTransferred)
await win.screenshot({ path: 'shots/36-folder-downloading.png' })

check('面板头部出现了「全部取消」', (await win.locator('.transfer-panel button[title="全部取消"]').count()) > 0)

// ---------- 全部取消 ----------
const t0 = Date.now()
await win.locator('.transfer-panel button[title="全部取消"]').click()

// 关键断言：取消之后在途/排队归零并稳定，最终落定「已取消」而不是「失败」
let stillRunning = 0
let stableRounds = 0
let finalText = ''
for (let i = 0; i < 60; i++) {
  await win.waitForTimeout(250)
  const c = await counts()
  if (c.active > 0 || c.pending > 0) {
    stillRunning++
    stableRounds = 0
  } else {
    stableRounds++
    if (stableRounds >= 4) {
      finalText = await win.evaluate(() =>
        [...document.querySelectorAll('.task .task-status')].map((e) => e.textContent.trim()).join('|')
      )
      break
    }
  }
}
console.log(`取消后 ${Date.now() - t0} ms：`, JSON.stringify(await counts()))

check('取消后不再有任务在传输或排队', stableRounds >= 4, `仍有动静的采样次数 ${stillRunning}`)
check('任务落定「已取消」而非「失败」', !finalText.includes('失败'), finalText)
// 自动消失是 3 秒后，上面那个循环在「安静下来」就退出了，这里得单独等
let panelGone = false
for (let i = 0; i < 40; i++) {
  await win.waitForTimeout(250)
  if ((await win.locator('.transfer-panel').count()) === 0) {
    panelGone = true
    break
  }
}
check('取消的那些条目随后自动消失', panelGone)
await win.screenshot({ path: 'shots/37-folder-canceled.png' })

// ---------- 清理 ----------
await input.click()
await win.keyboard.type(`rm -rf ~/${DIR}`)
await win.keyboard.press('Enter')
await win.waitForTimeout(2000)
await win.locator('.toolbar button[title="刷新"]').click()
await win.waitForTimeout(1500)
check('远端测试目录已清理', !(await rows()).includes(DIR))

rmSync(LOCAL_OUT, { recursive: true, force: true })
await win.evaluate(() => window.api.setLayout({ tabs: [] }))
console.log(process.exitCode ? '\n结论: 存在失败项' : '\n结论: 全部通过')
await app.close()
process.exit(process.exitCode ?? 0)

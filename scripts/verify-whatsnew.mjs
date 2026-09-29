/**
 * 更新公告（「本次更新了什么」）端到端：
 *  A. 首次运行（无 lastSeenVersion）→ 不弹，且静默记成当前版本
 *  B. 从旧版本升级（lastSeenVersion 是旧版）→ 弹公告，版本与条目数对得上
 *  C. 关闭公告 → 落盘已读 → 再启动不再弹
 *
 * 手法：直接改 userData/dox-settings.json 的 lastSeenVersion（应用未运行时），
 * 收尾恢复原值 —— 改了真实配置就必须还原，这是本机共享状态。
 *
 * 用法：node scripts/verify-whatsnew.mjs
 * 前置：npm run build；退出已安装的 Dox.app（单实例锁会让脚本假启动）
 */
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

mkdirSync('shots', { recursive: true })

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// 上次跑挂可能留下僵尸实例（布局文件会污染本次运行）
try {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { stdio: 'ignore' })
  } else {
    execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
  }
} catch { /* 没有正好 */ }

// userData 路径按平台约定（与 electron app.getPath('userData') 一致，应用名来自 package.json name）
const userData =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA, 'dox')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'dox')
      : path.join(os.homedir(), '.config', 'dox')
const settingsFile = path.join(userData, 'dox-settings.json')

const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
// 公告数据与构建同源：直接解析 whatsnew.ts 首条（build-agent.mjs 的同一份守卫口径）
const whatsNewSrc = fs.readFileSync('src/shared/whatsnew.ts', 'utf8')
const topVersion = whatsNewSrc.match(/WHATS_NEW[^=]*=\s*\[\s*\{\s*version:\s*'([^']+)'/)?.[1]
const topNotes = [...whatsNewSrc.matchAll(/notes:\s*\[([^\]]*)\]/g)][0]?.[1]
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.startsWith("'"))

// 改真实配置前的现场保全：整个文件原文留底，finally 里一字不差还回去
const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null

/** 写 lastSeenVersion（null = 删掉这个键，模拟首次运行） */
function setLastSeen(version) {
  const data = original ? JSON.parse(original) : { settings: null }
  if (version === null) delete data.lastSeenVersion
  else data.lastSeenVersion = version
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2))
}

function readLastSeen() {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).lastSeenVersion ?? null
}

async function launch() {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500) // 公告在 App onMounted 里异步拉取，给足往返
  return { app, win }
}

try {
  check('whatsnew.ts 首条与 package.json 对齐', topVersion === pkgVersion, `top=${topVersion} pkg=${pkgVersion}`)

  // ---- A. 首次运行：不弹，静默记住 ----
  setLastSeen(null)
  {
    const { app, win } = await launch()
    check('首次运行不弹公告', (await win.locator('.whatsnew-dialog').count()) === 0)
    await app.close()
    check('首次运行后已静默记成当前版本', readLastSeen() === pkgVersion, `got=${readLastSeen()}`)
  }

  // ---- B. 旧版本升级：弹公告，内容对得上 ----
  setLastSeen('0.0.1')
  {
    const { app, win } = await launch()
    const dialog = win.locator('.whatsnew-dialog')
    await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    check('升级后首次打开弹出公告', await dialog.isVisible())
    const title = (await dialog.locator('.dialog-header').textContent()) ?? ''
    check('公告标题带当前版本', title.includes(`v${pkgVersion}`), title.trim())
    const noteCount = await dialog.locator('.notes li').count()
    check('公告条目数与 whatsnew.ts 一致', noteCount === (topNotes?.length ?? -1), `ui=${noteCount} data=${topNotes?.length}`)
    await win.screenshot({ path: 'shots/97-whatsnew.png' })

    // ---- C. 关闭 → 落盘已读 → 再启动不弹 ----
    await dialog.locator('button:has-text("知道了")').click()
    await win.waitForTimeout(300)
    check('点「知道了」后弹窗消失', !(await dialog.isVisible()))
    await app.close()
    check('关闭后落盘为当前版本', readLastSeen() === pkgVersion, `got=${readLastSeen()}`)
  }

  {
    const { app, win } = await launch()
    check('再次启动不再弹', (await win.locator('.whatsnew-dialog').count()) === 0)
    await app.close()
  }
} finally {
  // 还原现场：脚本跑的是真实配置，lastSeenVersion 必须还回用户本来的值
  if (original === null) fs.rmSync(settingsFile, { force: true })
  else fs.writeFileSync(settingsFile, original)
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

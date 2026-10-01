/**
 * 更新公告端到端（v0.1.10 起改为「更新前展示」后的口径）：
 *  A. 启动后**不**自动弹公告（更新内容在 UpdateDialog 更新前展示，装完不重复打扰）
 *  B. 设置「关于」页点「更新内容」→ 弹出当前版本公告，版本与条目数对得上
 *  C. 关闭后还能再开（已读记账已拆，手动查看不受限）
 *
 * 用法：node scripts/verify-whatsnew.mjs
 * 前置：npm run build。隔离 userData，不碰已安装的 Dox.app。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'

process.on('unhandledRejection', () => {})

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// 公告数据与构建同源（build-agent.mjs 的同一份守卫口径）
const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const topEntry = JSON.parse(fs.readFileSync('src/shared/whatsnew.json', 'utf8'))[0]

const userData = '/tmp/dox-probe-whatsnew'
fs.rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)

try {
  // A. 启动不自动弹（哪怕配置里残留旧版的 lastSeenVersion 也不弹——机制已拆）
  check('启动后无自动公告弹窗', (await win.locator('.whatsnew-dialog').count()) === 0)
  check('公告首条与 package.json 对齐（守卫口径）', topEntry.version === pkgVersion,
    `${topEntry.version} vs ${pkgVersion}`)

  // B. 设置 → 关于 → 更新内容
  await win.locator('button.icon-btn[title="设置"]').click()
  await win.locator('.st-nav button', { hasText: '关于' }).click()
  await win.locator('.dir-pick-btn', { hasText: '更新内容' }).click()
  await win.locator('.whatsnew-dialog').waitFor({ timeout: 5000 })
  const header = (await win.locator('.whatsnew-dialog .dialog-header').textContent()) ?? ''
  check('弹出版本号对齐当前版本', header.includes(pkgVersion), header.trim())
  const noteCount = await win.locator('.whatsnew-dialog .notes li').count()
  check('条目数与 whatsnew.json 一致', noteCount === topEntry.notes.length,
    `${noteCount} vs ${topEntry.notes.length}`)

  // C. 关闭再开（无已读记账）
  await win.locator('.whatsnew-dialog .btn', { hasText: '知道了' }).click()
  await win.waitForTimeout(400)
  check('关闭后弹窗消失', (await win.locator('.whatsnew-dialog').count()) === 0)
  await win.locator('.dir-pick-btn', { hasText: '更新内容' }).click()
  await win.locator('.whatsnew-dialog').waitFor({ timeout: 5000 })
  check('再次打开仍可查看', true)

  await win.screenshot({ path: 'shots/101-whatsnew.png' })
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

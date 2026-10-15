/**
 * 文件面板落地目录回归：设置里配了「默认目录」(localDefaultDir) 时，
 * 本地会话的文件面板应落在该目录，而不是家目录。
 *
 * 用法：node scripts/verify-explorer-default-dir.mjs
 * 前置：npm run build。隔离 userData 起第二个实例，不碰已安装的 Dox。
 * 落地目录用 $HOME/dox-e2e-landing 夹具（区别于家目录本身，才能区分两条路径），结束自清理。
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.on('unhandledRejection', () => {})

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ---- 磁盘夹具：$HOME/dox-e2e-landing/marker.txt ----
const base = path.join(os.homedir(), 'dox-e2e-landing')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })
fs.writeFileSync(path.join(base, 'marker.txt'), 'x')

const userData = '/tmp/dox-probe-landing'
fs.rmSync(userData, { recursive: true, force: true })
// 预置设置：localDefaultDir 指向夹具目录（electron-store 的 dox-settings.json）
fs.mkdirSync(userData, { recursive: true })
fs.writeFileSync(
  path.join(userData, 'dox-settings.json'),
  JSON.stringify({ settings: { localDefaultDir: base } })
)

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

try {
  // ---- 开面板（默认本地标签）：应直接落在默认目录，列出 marker.txt ----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.waitForTimeout(800)
  const crumb = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('面板落在默认目录', crumb.includes('dox-e2e-landing'), crumb)
  check('列出夹具文件', (await win.locator('.explorer .row', { hasText: 'marker.txt' }).count()) === 1)

  // ---- 切走再切回：浏览历史恢复优先，仍应停在默认目录 ----
  await win.locator('button.tab-new').click()
  await win.waitForTimeout(2000)
  await win.locator('.tab').first().click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.waitForTimeout(800)
  const crumbBack = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('切回后仍在默认目录', crumbBack.includes('dox-e2e-landing'), crumbBack)
} catch (err) {
  check('脚本流程跑完', false, String(err))
} finally {
  await app.close().catch(() => {})
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)

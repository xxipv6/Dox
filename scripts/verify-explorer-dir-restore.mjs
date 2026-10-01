/**
 * 文件面板目录记忆回归：进子目录 → 切标签 → 切回来，应停在原目录而不是 home。
 *
 * 用法：node scripts/verify-explorer-dir-restore.mjs
 * 前置：npm run build。隔离 userData 起第二个实例，不碰已安装的 Dox.app。
 * 测试目录在 $HOME/dox-e2e-restore，结束自清理。
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

// ---- 磁盘夹具：$HOME/dox-e2e-restore/sub/keep.txt ----
const base = path.join(os.homedir(), 'dox-e2e-restore')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(path.join(base, 'sub'), { recursive: true })
fs.writeFileSync(path.join(base, 'sub', 'keep.txt'), 'x')

const userData = '/tmp/dox-probe-dir-restore'
fs.rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

try {
  // ---- 开面板（默认本地标签），进测试目录 ----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.locator('.explorer .row', { hasText: 'dox-e2e-restore' }).first().dblclick()
  await win.waitForTimeout(1200)
  const crumb1 = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('进入测试目录', crumb1.includes('dox-e2e-restore'), crumb1)
  // 再下一层，确认恢复的不是「恰好等于 home 的上一级」
  await win.locator('.explorer .row', { hasText: 'sub' }).first().dblclick()
  await win.waitForTimeout(1200)
  const crumb2 = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('进入 sub 子目录', crumb2.includes('sub'), crumb2)

  // ---- 切走：新建本地终端标签（面板跟着换到新标签的 home）----
  await win.locator('button.tab-new').click()
  await win.waitForTimeout(2000)
  check('新标签出现', (await win.locator('.tab').count()) >= 2)
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  const crumbAway = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('切走后是新标签的目录（不含 sub）', !crumbAway.includes('sub'), crumbAway)

  // ---- 切回来：应停在 sub，而不是 home ----
  await win.locator('.tab').first().click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.waitForTimeout(800)
  const crumbBack = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('切回停在原目录 sub', crumbBack.includes('sub'), crumbBack)
  check('原目录内容列出（keep.txt）',
    (await win.locator('.explorer .row', { hasText: 'keep.txt' }).count()) > 0)

  // ---- 后退历史也该活下来：点后退应回到 dox-e2e-restore（失忆则无反应）----
  await win.locator('.explorer button[title="后退（鼠标侧键）"]').click()
  await win.waitForTimeout(1000)
  const crumbHist = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('切回后后退历史仍在（回 dox-e2e-restore）',
    crumbHist.includes('dox-e2e-restore') && !crumbHist.includes('sub'), crumbHist)
  // 再前进回 sub，把现场恢复到「停在 sub」供后续断言
  await win.locator('.explorer button[title="前进（鼠标侧键）"]').click()
  await win.waitForTimeout(1000)

  // ---- 反向验证记忆是按标签隔离的：再切到第二个标签，不应被带到 sub ----
  await win.locator('.tab').nth(1).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.waitForTimeout(500)
  const crumbTab2 = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('第二个标签不受影响（仍无 sub）', !crumbTab2.includes('sub'), crumbTab2)

  await win.screenshot({ path: 'shots/98-explorer-dir-restore.png' })
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

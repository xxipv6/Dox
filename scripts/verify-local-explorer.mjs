/**
 * 本地终端文件面板端到端：
 *  本地标签 →「文件」按钮 → 本机面板（徽章/家目录落地）→ 进测试目录 →
 *  新建文件夹 / 重命名 / 编辑器改存 / 删除 全链路（都落到真实磁盘校验）→
 *  「在终端打开」cd 断言 → enqueueDropped 本机复制（队列 + 磁盘双重校验）→
 *  目录历史后退 → 磁盘用量条出现。
 *
 * 用法：node scripts/verify-local-explorer.mjs
 * 前置：npm run build。测试目录在 $HOME/dox-e2e-local，结束自清理。
 */
import { _electron as electron } from 'playwright'
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

// ---- 磁盘夹具：$HOME/dox-e2e-local/{sub/c.txt, a.txt} ----
const base = path.join(os.homedir(), 'dox-e2e-local')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(path.join(base, 'sub'), { recursive: true })
fs.mkdirSync(path.join(base, 'copydst'))
fs.writeFileSync(path.join(base, 'a.txt'), 'hello-local')
fs.writeFileSync(path.join(base, 'sub', 'c.txt'), 'x')

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

try {
  // ---- 默认目录设置：设成测试目录 → 新开本地终端落在那（标签名带目录名）----
  await win.evaluate(async (dir) => {
    const s = await window.api.getSettings()
    await window.api.setSettings({ ...s, localDefaultDir: dir })
    location.reload()
  }, base)
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)
  let fellIntoDefault = false
  for (let i = 0; i < 10; i++) {
    const t = (await win.locator('.tab').first().textContent()) ?? ''
    if (t.includes('dox-e2e-local')) { fellIntoDefault = true; break }
    await win.waitForTimeout(500)
  }
  check('默认目录设置生效（新终端落在默认目录）', fellIntoDefault)
  // 清掉设置再重来，后续用例从家目录出发
  await win.evaluate(async () => {
    const s = await window.api.getSettings()
    await window.api.setSettings({ ...s, localDefaultDir: '' })
    location.reload()
  })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)

  // ---- 开面板 ----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  check('本机徽章出现', await win.locator('.explorer .ctr-badge', { hasText: '本机' }).count() === 1)

  // ---- 进测试目录（家目录里 dblclick）----
  await win.locator('.explorer .row', { hasText: 'dox-e2e-local' }).first().dblclick()
  await win.waitForTimeout(1200)
  const crumb = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('进入测试目录', crumb.includes('dox-e2e-local'), crumb)
  check('列出子目录与文件',
    (await win.locator('.explorer .row', { hasText: 'sub' }).count()) > 0 &&
    (await win.locator('.explorer .row', { hasText: 'a.txt' }).count()) > 0)

  // ---- 新建文件夹 ----
  await win.locator('.explorer button[title="新建文件夹"]').click()
  await win.locator('.explorer .rename-input').fill('made')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(800)
  check('新建文件夹落盘', fs.existsSync(path.join(base, 'made')))

  // ---- 重命名 a.txt → b.txt ----
  await win.locator('.explorer .row', { hasText: 'a.txt' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '重命名' }).click()
  await win.locator('.explorer .rename-input').fill('b.txt')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(800)
  check('重命名落盘', fs.existsSync(path.join(base, 'b.txt')) && !fs.existsSync(path.join(base, 'a.txt')))

  // ---- 编辑器：打开 b.txt，改成 bye-local 保存，磁盘校验 ----
  await win.locator('.explorer .row', { hasText: 'b.txt' }).first().dblclick()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  await win.waitForTimeout(600)
  const cmText = (await win.locator('.cm-content').textContent()) ?? ''
  check('编辑器读出内容', cmText.includes('hello-local'), cmText.slice(0, 40))
  await win.locator('.cm-content').click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.type('bye-local')
  await win.keyboard.press('Meta+s')
  await win.waitForTimeout(800)
  check('编辑器保存落盘', fs.readFileSync(path.join(base, 'b.txt'), 'utf8') === 'bye-local')

  // ---- 在终端打开此目录 ----
  await win.locator('.explorer button[title="在终端中打开此目录"]').click()
  await win.waitForTimeout(1200)
  const termText = await win.evaluate(
    () => document.querySelector('.tab-content:not([style*="display: none"]) .xterm-rows')?.textContent ?? ''
  )
  check('终端收到 cd 到测试目录', termText.includes('dox-e2e-local'), termText.slice(-60))

  // ---- 本机复制：enqueueDropped（复制进 copydst）----
  await win.evaluate(
    ([src, dst]) =>
      window.api.enqueueDropped('local-verify', dst, [{ path: src, name: 'b.txt', size: 9 }]),
    [path.join(base, 'b.txt'), path.join(base, 'copydst')]
  )
  let copied = false
  for (let i = 0; i < 20; i++) {
    await win.waitForTimeout(500)
    if (fs.existsSync(path.join(base, 'copydst', 'b.txt'))) { copied = true; break }
  }
  check('本机复制落盘', copied && fs.readFileSync(path.join(base, 'copydst', 'b.txt'), 'utf8') === 'bye-local')
  const tasks = await win.evaluate(() => window.api.listTransfers())
  check('复制任务进队列且完成', tasks.some((t) => t.status === 'done' && t.remotePath.includes('copydst')))

  // ---- 打包（系统 tar）：b.txt → b.txt.tar.gz ----
  await win.locator('.explorer .row', { hasText: 'b.txt' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '打包' }).click()
  let archived = false
  for (let i = 0; i < 20; i++) {
    await win.waitForTimeout(500)
    if (fs.existsSync(path.join(base, 'b.txt.tar.gz'))) { archived = true; break }
  }
  check('打包落盘（系统 tar）', archived)

  // ---- 删除（右键 made → 删除，dialog 自动确认）----
  await win.locator('.explorer .row', { hasText: 'made' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '删除' }).click()
  await win.waitForTimeout(800)
  check('删除落盘', !fs.existsSync(path.join(base, 'made')))

  // ---- 目录历史：进 sub → 后退回来 ----
  await win.locator('.explorer .row', { hasText: 'sub' }).first().dblclick()
  await win.waitForTimeout(1000)
  check('进入 sub', ((await win.locator('.explorer .breadcrumb').textContent()) ?? '').includes('sub'))
  await win.locator('.explorer button[title="后退（鼠标侧键）"]').click()
  await win.waitForTimeout(1000)
  const crumbBack = (await win.locator('.explorer .breadcrumb').textContent()) ?? ''
  check('后退回测试目录', crumbBack.includes('dox-e2e-local') && !crumbBack.includes('sub'), crumbBack)

  // ---- 磁盘用量条（本机 statfs，POSIX 必有；Windows 没有就藏）----
  if (process.platform !== 'win32') {
    check('磁盘用量条出现', await win.locator('.explorer .usage-bar').count() === 1)
  }

  await win.screenshot({ path: 'shots/97-local-explorer.png' })
} finally {
  fs.rmSync(base, { recursive: true, force: true })
  await win.evaluate(() => window.api.setLayout({ tabs: [] })).catch(() => undefined)
  await app.close()
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

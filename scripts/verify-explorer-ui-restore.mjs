/**
 * 文件面板界面状态跨重挂载恢复：滚动位置 / 项目树展开 / 搜索快照。
 * 切标签会销毁重建 FileExplorer（App.vue 按 sessionId 作 key），这些状态
 * 曾随之蒸发 —— 本脚本逐项断言「切走再切回 = 回到离开时的样子」。
 *
 * 用法：node scripts/verify-explorer-ui-restore.mjs
 * 前置：npm run build。隔离 userData，不碰已安装的 Dox.app。
 * 测试目录在 $HOME/dox-e2e-ui，结束自清理。
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

// ---- 磁盘夹具：dox-e2e-ui/{f00..f39}.txt（撑出滚动条）+ proj/{README.md,src/{a.ts,deep/b.ts}} ----
const base = path.join(os.homedir(), 'dox-e2e-ui')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(path.join(base, 'proj', 'src', 'deep'), { recursive: true })
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(base, `f${String(i).padStart(2, '0')}.txt`), 'x')
fs.writeFileSync(path.join(base, 'proj', 'README.md'), 'needle in readme\n')
fs.writeFileSync(path.join(base, 'proj', 'src', 'a.ts'), '// needle in src\n')
fs.writeFileSync(path.join(base, 'proj', 'src', 'deep', 'b.ts'), 'export const b = 1\n')

const userData = '/tmp/dox-probe-ui-restore'
fs.rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const scrollTop = () => win.evaluate(() => document.querySelector('.file-list')?.scrollTop ?? -1)
const switchAwayAndBack = async () => {
  await win.locator('button.tab-new').click()
  await win.waitForTimeout(1500)
  await win.locator('.tab').first().click()
  await win.waitForTimeout(1500)
}

try {
  // ---- browse：进测试目录，滚到底 ----
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.locator('.explorer .row', { hasText: 'dox-e2e-ui' }).first().dblclick()
  await win.waitForTimeout(1200)
  await win.evaluate(() => {
    const el = document.querySelector('.file-list')
    if (el) el.scrollTop = el.scrollHeight
  })
  await win.waitForTimeout(300)
  const scrolled = await scrollTop()
  check('列表可滚动（夹具撑出滚动条）', scrolled > 100, `scrollTop=${scrolled}`)

  // ---- 切走再切回：滚动位置应原地保留 ----
  await switchAwayAndBack()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.waitForTimeout(600)
  const restored = await scrollTop()
  check('滚动位置恢复', restored > 0 && Math.abs(restored - scrolled) <= 4, `期望~${scrolled} 实际${restored}`)

  // ---- 进项目模式（右键 proj 行 → 进入项目模式），展开 src ----
  await win.locator('.explorer .row', { hasText: 'proj' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '进入项目模式' }).click()
  await win.locator('.tree-row').first().waitFor({ timeout: 10000 })
  await win.locator('.tree-row', { hasText: 'src' }).first().click()
  await win.locator('.tree-row', { hasText: 'deep' }).waitFor({ timeout: 5000 })
  check('项目模式展开 src → deep 可见', true)

  // ---- 搜索 needle：两个文件命中 ----
  await win.locator('.rail-btn[title^="在项目中搜索"]').click()
  await win.locator('.search-panel .search-input').fill('needle')
  await win.waitForTimeout(1500)
  const groups1 = await win.locator('.search-group').count()
  check('搜索出结果（README + a.ts）', groups1 >= 2, `groups=${groups1}`)

  // ---- 切走再切回：搜索视图/查询/结果应原样回来 ----
  await switchAwayAndBack()
  await win.locator('.search-panel .search-input').waitFor({ timeout: 10000 })
  const q = await win.locator('.search-panel .search-input').inputValue()
  check('切回后搜索视图仍在且查询还在', q === 'needle', `query=${q}`)
  const groups2 = await win.locator('.search-group').count()
  check('搜索结果快照还在（未重搜清空）', groups2 >= 2, `groups=${groups2}`)
  const status = (await win.locator('.search-status').textContent()) ?? ''
  check('完成统计还在', status.includes('条结果'), status.trim())

  // ---- 切回树：展开状态应还原（deep 直接可见，不等重新逐层拉取）----
  await win.locator('.rail-btn[title="项目文件"]').click()
  await win.waitForTimeout(600)
  check('树展开状态恢复（deep 立即可见）',
    (await win.locator('.tree-row', { hasText: 'deep' }).count()) === 1)

  // ---- 同挂载内的退出再进（快照走组件内 captureSubs，不是 store 那条路）----
  await win.locator('.explorer button[title="退出项目模式"]').click()
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  await win.locator('.explorer .row', { hasText: 'proj' }).first().click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '进入项目模式' }).click()
  await win.locator('.tree-row').first().waitFor({ timeout: 10000 })
  check('退出再进：树展开仍在（deep 可见）',
    (await win.locator('.tree-row', { hasText: 'deep' }).count()) === 1)
  await win.locator('.rail-btn[title^="在项目中搜索"]').click()
  const q2 = await win.locator('.search-panel .search-input').inputValue()
  check('退出再进：搜索查询还在', q2 === 'needle', `query=${q2}`)

  await win.screenshot({ path: 'shots/100-explorer-ui-restore.png' })
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

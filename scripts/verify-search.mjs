/**
 * 项目模式全文搜索 端到端验证。
 *
 * 阶段 1（纯函数，Node 24 type stripping 直 import 主进程源码）：
 *   命令构造 / 行重组 / rg·grep 输出解析 / node 兜底引擎真遍历。
 * 阶段 2（本机 e2e，playwright）：
 *   项目模式 → 搜索 → 分组/排除/二进制断言 → 点匹配跳行 → Aa/正则开关 → Esc 回树。
 *
 * 用法：node scripts/verify-search.mjs
 * 前置：npm run build；退出已安装的 Dox.app（单实例锁）。
 *      agent 侧 Go 测试归 `cd agent && go test ./...`（本脚本不管）。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  buildRgArgs,
  buildRgCommand,
  buildGrepArgs,
  buildGrepCommand,
  createLineAccumulator,
  createNodeMatcher,
  isPatternSafe,
  parseGrepLine,
  parseRgJsonLine,
  truncatePreview,
  SEARCH_PREVIEW_MAX
} from '../src/main/search/commands.ts'
import { searchLocalNode } from '../src/main/search/localNodeSearch.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// ==================== 阶段 1：纯函数 ====================
console.log('阶段 1：命令构造与输出解析')

const q = { root: '/srv/app', pattern: 'hello', isRegex: false, ignoreCase: true }

// buildRgArgs：--json/排除/-i/-F/-- 分隔
const rgArgs = buildRgArgs(q)
check('rg argv 含 --json 与排除', rgArgs.includes('--json') && rgArgs.includes('!.git') && rgArgs.includes('!node_modules'))
check('rg argv -i 与 -F', rgArgs.includes('-i') && rgArgs.includes('-F'))
check('rg argv -- 后是 pattern 与 root', rgArgs.slice(-3).join('|') === '--|hello|/srv/app')
const rgArgsRe = buildRgArgs({ ...q, isRegex: true, ignoreCase: false })
check('rg argv 正则档：无 -F 无 -i', !rgArgsRe.includes('-F') && !rgArgsRe.includes('-i'))

// buildRgCommand：单引号转义（pattern 含单引号 + 空格）
const cmd = buildRgCommand('/usr/bin/rg', { root: '/srv/a b', pattern: "it's", isRegex: false, ignoreCase: false })
check('rg 远端命令 quoting', cmd.includes(`'it'\\''s'`) && cmd.includes(`'/srv/a b'`), cmd)

// grep 两形态
const gNul = buildGrepArgs(q, { nul: true })
check('grep --null 形态', gNul.includes('--null') && gNul.includes('--exclude-dir=.git'))
const gNoNul = buildGrepArgs(q, { nul: false })
check('grep 非 --null 形态', !gNoNul.includes('--null'))
check('grep 远端命令 quoting', buildGrepCommand({ ...q, pattern: "a'b" }, { nul: true }).includes(`'a'\\''b'`))

// createLineAccumulator：跨 chunk 拆行 + \r + 尾部冲刷
{
  const lines = []
  const acc = createLineAccumulator((l) => lines.push(l))
  acc.feed('ab\nc')
  acc.feed('d\r\nef')
  acc.end()
  check('行重组跨 chunk', lines.join('|') === 'ab|cd|ef', lines.join('|'))
}

// parseRgJsonLine：text 形态 / bytes 形态 / 非 match / 非 JSON
{
  const m = parseRgJsonLine(JSON.stringify({
    type: 'match',
    data: {
      path: { text: '/srv/app/a.txt' },
      lines: { text: 'say hello\n' },
      line_number: 7,
      submatches: [{ start: 4 }]
    }
  }))
  check('rg text 形态', m?.path === '/srv/app/a.txt' && m.line === 7 && m.col === 4 && m.text === 'say hello')
  const b64 = Buffer.from('/srv/app/中文.txt', 'utf8').toString('base64')
  const mb = parseRgJsonLine(JSON.stringify({
    type: 'match',
    data: { path: { bytes: b64 }, lines: { text: 'x' }, line_number: 1, submatches: [] }
  }))
  check('rg bytes 形态（base64 路径）', mb?.path === '/srv/app/中文.txt', mb?.path)
  check('rg 非 match 消息 → null', parseRgJsonLine(JSON.stringify({ type: 'begin', data: {} })) === null)
  check('rg 非 JSON 行 → null', parseRgJsonLine('not json at all') === null)
}

// parseGrepLine：nul 形态（路径含冒号！）与非 nul 形态
{
  const m1 = parseGrepLine('/srv/we:ird/a.txt\0' + '12:hello world', { nul: true })
  check('grep nul 形态（路径含冒号）', m1?.path === '/srv/we:ird/a.txt' && m1.line === 12 && m1.text === 'hello world', JSON.stringify(m1))
  const m2 = parseGrepLine('/srv/app/b.txt:3:hit here', { nul: false })
  check('grep 冒号形态', m2?.path === '/srv/app/b.txt' && m2.line === 3 && m2.text === 'hit here')
  check('grep 非结果行 → null', parseGrepLine('grep: something: Permission denied', { nul: true }) === null)
}

// truncatePreview / isPatternSafe / createNodeMatcher
check('预览截断', truncatePreview('x'.repeat(SEARCH_PREVIEW_MAX + 10)).length === SEARCH_PREVIEW_MAX)
check('pattern 安全校验', isPatternSafe('ok') && !isPatternSafe('a\nb') && !isPatternSafe(''))
{
  const lit = createNodeMatcher({ pattern: 'Hello', isRegex: false, ignoreCase: true })
  check('node 匹配器纯文本忽略大小写', lit.match('say HELLO') === 4 && lit.match('nothing') === -1)
  const re = createNodeMatcher({ pattern: 'h.llo', isRegex: true, ignoreCase: false })
  check('node 匹配器正则', re.match('hello') === 0 && re.match('hxllo') === 0 && re.match('hllo') === -1)
  const bad = createNodeMatcher({ pattern: '([', isRegex: true, ignoreCase: false })
  check('node 无效正则 → error', typeof bad.error === 'string' && bad.error.length > 0)
}

// localNodeSearch 真遍历（tmpdir 夹具）
{
  const root = path.join(tmpdir(), `dox-node-search-${Date.now()}`)
  mkdirSync(path.join(root, 'sub'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  writeFileSync(path.join(root, 'a.txt'), 'Hello\nHELLO\n')
  writeFileSync(path.join(root, 'sub', 'b.txt'), 'hello b\n')
  writeFileSync(path.join(root, 'node_modules', 'x.js'), 'hello nm\n')
  writeFileSync(path.join(root, 'bin.dat'), 'hello\0bin\n')
  const matches = []
  const matcher = createNodeMatcher({ pattern: 'hello', isRegex: false, ignoreCase: true })
  const res = await searchLocalNode(root, matcher.match, 2000, {
    onBatch: (m) => matches.push(...m),
    shouldAbort: () => false
  })
  const paths = matches.map((m) => m.path).join('|')
  check('node 遍历命中 a.txt×2 + b.txt', matches.length === 3, String(matches.length))
  check('node 遍历排除 node_modules 与二进制', !paths.includes('node_modules') && !paths.includes('bin.dat'))
  check('node 遍历不 truncated', res.truncated === false && res.filesSearched === 2, JSON.stringify(res))
  // Abort 协作取消
  const m2 = []
  let calls = 0
  await searchLocalNode(root, matcher.match, 2000, {
    onBatch: (m) => m2.push(...m),
    shouldAbort: () => ++calls > 0
  })
  check('node Abort 立即收手', m2.length === 0)
  rmSync(root, { recursive: true, force: true })
}

// ==================== 阶段 2：本机 e2e ====================
console.log('\n阶段 2：本机 e2e（项目模式搜索面板）')

const { _electron: electron } = await import('playwright')
mkdirSync('shots', { recursive: true })

// 磁盘夹具：$HOME/dox-e2e-search/
const base = path.join(os.homedir(), 'dox-e2e-search')
rmSync(base, { recursive: true, force: true })
mkdirSync(path.join(base, 'sub', 'deep'), { recursive: true })
mkdirSync(path.join(base, 'node_modules'), { recursive: true })
writeFileSync(path.join(base, 'a.txt'), 'Hello world\nnothing\nsay HELLO again\n')
writeFileSync(path.join(base, 'sub', 'b.txt'), 'hello from b\n')
writeFileSync(path.join(base, 'sub', 'deep', 'c.log'), 'hello from c\n')
writeFileSync(path.join(base, 'node_modules', 'x.js'), 'hello from nm\n')
writeFileSync(path.join(base, 'bin.dat'), 'hello\0binary\n')
writeFileSync(path.join(base, 'long.txt'), 'x'.repeat(10 * 1024) + 'hello' + 'y'.repeat(10 * 1024) + '\n')

try {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { stdio: 'ignore' })
  } else {
    execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
  }
} catch { /* 没有正好 */ }

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
const origSettings = await win.evaluate(() => window.api.getSettings())
await win.evaluate(async (s) => {
  await window.api.setSettings({ ...s, projectRoots: {} })
  await window.api.setLayout({ tabs: [] })
  location.reload()
}, origSettings)
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const rowWith = (sel, text) =>
  win.locator(sel).filter({ has: win.locator(`.file-name:text-is("${text}")`) }).first()
const statusText = async () => (await win.locator('.search-panel .search-status').first().textContent().catch(() => '')) ?? ''
/** 等状态条出现「N 条结果」并抠出 N。prevText：新一轮必须等到文本**变了**才算
 * （300ms 防抖窗口内旧 done 还在状态条上，直接读会拿到上一轮的结果误判） */
async function waitMatchCount(timeoutMs = 15000, prevText = '') {
  const started = Date.now()
  for (;;) {
    const t = await statusText()
    const m = /(\d+) 条结果/.exec(t)
    if (m && t !== prevText) return { count: Number(m[1]), text: t }
    if (Date.now() - started > timeoutMs) return { count: -1, text: t }
    await win.waitForTimeout(300)
  }
}

try {
  // 开面板 → 右键进入项目模式
  await win.locator('button.bar-btn', { hasText: '文件' }).click()
  await win.locator('.explorer .file-list .row').first().waitFor({ timeout: 10000 })
  await rowWith('.explorer .file-list .row', 'dox-e2e-search').click({ button: 'right' })
  await win.locator('.context-menu .menu-item', { hasText: '进入项目模式' }).click()
  await win.locator('.explorer .project-bar').waitFor({ timeout: 5000 })

  // 开搜索面板（左栏图标轨的查找按钮）
  await win.locator('.explorer .project-rail button[title^="在项目中搜索"]').click()
  await win.locator('.search-panel .search-input').waitFor({ timeout: 5000 })
  check('搜索面板打开且输入框聚焦',
    await win.evaluate(() => document.activeElement?.classList.contains('search-input')))
  check('图标轨：查找激活、项目文件在列',
    (await win.locator('.explorer .project-rail button[title="项目文件"]').count()) === 1 &&
    (await win.locator('.explorer .project-rail .rail-btn.active[title^="在项目中搜索"]').count()) === 1)

  // 输入 hello：a.txt×2 + b.txt + c.log + long.txt = 5 条，4 个文件分组
  await win.locator('.search-panel .search-input').fill('hello')
  const first = await waitMatchCount()
  check('搜索结果计数（5 条）', first.count === 5, first.text)
  check('结果分组成 4 个文件', (await win.locator('.search-panel .search-group').count()) === 4)
  const groupPaths = (await win.locator('.search-panel .group-path').allTextContents()).join('|')
  check('node_modules 与二进制不出现',
    !groupPaths.includes('node_modules') && !groupPaths.includes('bin.dat'), groupPaths)
  check('引擎徽章出现', (await win.locator('.search-panel .engine-badge').count()) === 1, first.text)

  // 点 b.txt 的匹配 → 编辑器打开 b.txt 且跳到第 1 行（activeLine 存在）
  await win.locator('.search-panel .search-group', { hasText: 'b.txt' }).locator('.search-match').first().click()
  await win.locator('.editor-panel .etab', { hasText: 'b.txt' }).waitFor({ timeout: 10000 })
  check('点匹配打开编辑器', (await win.locator('.editor-panel .etab', { hasText: 'b.txt' }).count()) === 1)
  await win.waitForTimeout(500)
  check('编辑器活动行（跳行生效）', (await win.locator('.cm-activeLine').count()) > 0)

  // Aa（大小写敏感）：hello 只剩 b/c/long 三处（a.txt 的 Hello/HELLO 不再命中）
  await win.locator('.search-panel button[title="大小写敏感"]').click()
  const sensitive = await waitMatchCount(15000, first.text)
  check('大小写敏感后结果变少（3 条）', sensitive.count === 3, sensitive.text)
  await win.locator('.search-panel button[title="大小写敏感"]').click() // 还原忽略大小写

  // .*（正则）：h.llo 命中 hello/Hello/HELLO（5 条）
  await win.locator('.search-panel button[title="使用正则表达式"]').click()
  await win.locator('.search-panel .search-input').fill('h.llo')
  const regex = await waitMatchCount(15000, sensitive.text)
  check('正则搜索（5 条）', regex.count === 5, regex.text)

  // Esc 回树：树行还在（v-show 保活，没打回冷启动）
  await win.locator('.search-panel .search-input').press('Escape')
  await win.waitForTimeout(300)
  check('Esc 回树且树行还在',
    (await rowWith('.explorer .tree .tree-row', 'a.txt').count()) === 1 &&
    (await win.locator('.search-panel:visible').count()) === 0)

  // 右键「从文件夹中查找」：范围缩到 sub（只剩 b/c 两条），chip 可重置回全项目
  // （先回到纯文本 hello 并**确实等到**它的新 done——否则旧 done 落在后面的
  //   等待窗口里会被当成范围搜索的结果，亲身踩过）
  await win.locator('.explorer .project-rail button[title^="在项目中搜索"]').click()
  const beforePlain = await statusText()
  await win.locator('.search-panel button[title="使用正则表达式"]').click()
  await win.locator('.search-panel .search-input').fill('hello')
  await waitMatchCount(15000, beforePlain)
  await win.locator('.search-panel .search-input').press('Escape')
  await rowWith('.explorer .tree .tree-row', 'sub').click({ button: 'right' })
  const findItem = win.locator('.context-menu .menu-item', { hasText: '从文件夹中查找' })
  check('文件夹右键含「从文件夹中查找」', (await findItem.count()) === 1)
  const beforeScoped = await statusText()
  await findItem.click()
  await win.locator('.search-panel .scope-row').waitFor({ timeout: 5000 })
  check('范围 chip 出现（sub）',
    ((await win.locator('.search-panel .scope-row').textContent()) ?? '').includes('sub'))
  const scoped = await waitMatchCount(15000, beforeScoped)
  check('限定范围后只剩 sub 下的结果（2 条）', scoped.count === 2, scoped.text)
  await win.locator('.search-panel .scope-row button[title="重置为整个项目"]').click()
  const unscoped = await waitMatchCount(15000, scoped.text)
  check('重置范围回到全项目（5 条）', unscoped.count === 5, unscoped.text)

  await win.screenshot({ path: 'shots/search-panel.png' })
} catch (err) {
  console.log('  FAIL 异常中断', err)
  failed = true
  try {
    await win.screenshot({ path: 'shots/search-panel-fail.png' })
  } catch { /* 截图也失败就算了 */ }
} finally {
  try {
    if (origSettings) {
      await win.evaluate((s) => window.api.setSettings({ ...s, projectRoots: {} }), origSettings)
    }
  } catch { /* 实例可能已死 */ }
  await app.close().catch(() => undefined)
  rmSync(base, { recursive: true, force: true })
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

/**
 * 编辑器语法配色 / 字体截图，供人工核对（断言型验证是 verify-theme.mjs）。
 *
 * 对着 shots/syntax-{dark,light}.png 与前缀 -ts 的四张图，比读 computed style 直观：
 * 深浅两套都该是 VS Code 内置主题的样子（Dark+ / Light+），字体是 Menlo/Consolas 那一档。
 * 顺带把关键 token 的实色打出来，改完 palette 一眼就能看出哪一档串了。
 *
 * 用**隔离的 userData** 起应用：不读也不写本机真实设置（主题/项目根都不会被带跑）。
 *
 * 用法：node scripts/shot-syntax.mjs
 * 前置：npm run build；退出已安装的 Dox.app（单实例锁）
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

fs.mkdirSync('shots', { recursive: true })

// ---- 磁盘夹具：$HOME/dox-e2e-syntax/ ----
const base = path.join(os.homedir(), 'dox-e2e-syntax')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })

fs.writeFileSync(
  path.join(base, 'CLAUDE.md'),
  [
    '# SRC Platform',
    '',
    '**环境**: 授权漏洞赏金（企业 SRC / 公开众测 / 漏洞报送）。**模式固定**（`rules/workflow.md` 锁定）。',
    '',
    '## 架构',
    '',
    '阶段化并行流水线（主 Agent 编排 4 个 subagent）：目标接收 → 资产分诊 → 业务流与假设。',
    '',
    '- `rules/workflow.md` — 流水线与检查点',
    '- [维护手册](https://example.com/docs) 见上文',
    '',
    '```bash',
    'npm install',
    'npm run dev   # 开发（HMR）：围栏里的注释该是绿的',
    '```',
    '',
    '> 引用一行：数字 42 与 true 也要有色。',
    ''
  ].join('\n')
)

fs.writeFileSync(
  path.join(base, 'package.json'),
  [
    '{',
    '  "name": "dox",',
    '  "version": "0.1.4",',
    '  "description": "SSH 客户端",',
    '  "main": "out/main/index.js",',
    '  "scripts": { "dev": "electron-vite dev", "count": 42 },',
    '  "private": true',
    '}',
    ''
  ].join('\n')
)

fs.writeFileSync(
  path.join(base, 'sample.ts'),
  `import { readFile } from 'node:fs/promises'

/** 示例：颜色分档验证 */
export interface Job {
  id: number
  name: string
  done: boolean
}

const RE = /^job-(\\d+)$/

export async function loadJobs(file: string, limit = 10): Promise<Job[]> {
  const raw = await readFile(file, 'utf8')
  const jobs: Job[] = JSON.parse(raw)
  return jobs.filter((j) => !j.done).slice(0, limit)
}
`
)

try {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*Dox\\node_modules\\electron*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { stdio: 'ignore' })
  } else {
    execFileSync('pkill', ['-f', 'Dox/node_modules/electron'], { stdio: 'ignore' })
  }
} catch { /* 没有正好 */ }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dox-shot-'))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)

async function setTheme(theme) {
  await win.evaluate(async (t) => {
    const s = await window.api.getSettings()
    await window.api.setSettings({ ...s, uiTheme: t })
    await window.api.setLayout({ tabs: [] })
  }, theme)
  await win.evaluate(() => location.reload())
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)
}

async function openFixture(file) {
  // 「文件」是可切换按钮：面板已开着时再点会关掉
  if ((await win.locator('.explorer .row').count()) === 0) {
    await win.locator('button.bar-btn', { hasText: '文件' }).click()
  }
  await win.locator('.explorer .row').first().waitFor({ timeout: 10000 })
  if ((await win.locator('.explorer .breadcrumb', { hasText: 'dox-e2e-syntax' }).count()) === 0) {
    await win.locator('.explorer .row', { hasText: 'dox-e2e-syntax' }).first().dblclick()
    await win.waitForTimeout(1000)
  }
  await win.locator('.explorer .row', { hasText: file }).first().dblclick()
  await win.locator('.cm-content').waitFor({ timeout: 10000 })
  await win.waitForTimeout(700)
}

/** 编辑器里出现的前景/背景色取样（CodeMirror 把配色写成行内 style） */
const sampleColors = (from, to) => win.evaluate(([a, b]) => {
  const seen = new Set()
  for (const line of [...document.querySelectorAll('.cm-content .cm-line')].slice(a, b)) {
    for (const el of line.querySelectorAll('span')) {
      const c = getComputedStyle(el).color
      if (c) seen.add(`${el.textContent.slice(0, 18)} → ${c}`)
    }
  }
  return [...seen]
}, [from, to])

for (const theme of ['dark', 'light']) {
  await setTheme(theme)
  await openFixture('CLAUDE.md')
  const font = await win.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.cm-content'))
    return `${cs.fontFamily} / ${cs.lineHeight}`
  })
  console.log(`[${theme}] ${font}`)
  // chrome 对齐断言素材：底色/正文/行号（--ed-* 令牌落到编辑器上的实值）
  const chrome = await win.evaluate(() => {
    const ed = getComputedStyle(document.querySelector('.cm-editor'))
    const gutters = getComputedStyle(document.querySelector('.cm-gutters'))
    const num = document.querySelector('.cm-gutterElement')
    return {
      editorBg: ed.backgroundColor,
      editorFg: ed.color,
      gutterBg: gutters.backgroundColor,
      gutterFg: gutters.color,
      fontSize: ed.fontSize
    }
  })
  console.log(`[${theme}] chrome：`, chrome)
  console.log(`[${theme}] markdown：`)
  for (const s of await sampleColors(10, 16)) console.log('   ', s) // 含围栏代码块
  await win.screenshot({ path: `shots/syntax-${theme}.png` })

  await openFixture('package.json')
  console.log(`[${theme}] json：`)
  for (const s of await sampleColors(1, 5)) console.log('   ', s) // key/字符串/数字/标点都有
  await win.screenshot({ path: `shots/syntax-${theme}-json.png` })

  await openFixture('sample.ts')
  console.log(`[${theme}] typescript：`)
  for (const s of await sampleColors(0, 12)) console.log('   ', s)
  await win.screenshot({ path: `shots/syntax-${theme}-ts.png` })
}

await app.close().catch(() => undefined)
fs.rmSync(base, { recursive: true, force: true })
fs.rmSync(userData, { recursive: true, force: true })
console.log('\n截图：shots/syntax-{dark,light}[-ts].png')

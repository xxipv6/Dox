/**
 * 用 headless xterm 把 pty 输出渲染成真实屏幕，并对画面做自动断言。
 * 覆盖：不同宽度、逐字符输入（PSReadLine 重绘）、窗口 resize（conpty 重排）。
 *
 * 用法：node scripts/verify-render.mjs [COLS] [ROWS]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const { Sentry } = require('zmodem.js')

const profilePath = join(tmpdir(), 'dox-verify-profile.ps1')
writeFileSync(profilePath, readFileSync('src/main/local/scripts/dox-profile.ps1', 'utf8'))

/** ls 输出行的正确形态：Mode(5) + 空格 + 日期 */
const MODE_RE = /^([-d][-a-z]{4})\s+\d{4}-\d{2}-\d{2}/

function collectScreen(term, rows) {
  const buf = term.buffer.active
  const out = []
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.baseY + y)
    out.push(line ? line.translateToString(true) : '')
  }
  return out
}

/** 断言画面没有把提示符字符写进输出行 */
function checkScreen(lines, tag) {
  const problems = []
  lines.forEach((text, y) => {
    if (!text.trim()) return
    // 形如 ls 输出但 Mode 列被污染的（出现 ~ > 等提示符字符）
    const looksLikeListing = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(text)
    if (looksLikeListing && !MODE_RE.test(text) && !/^[d-]\S{0,6}\s+\d{4}-/.test(text)) {
      problems.push(`  行${y}: ${JSON.stringify(text.slice(0, 60))}`)
    }
  })
  console.log(`  ${tag}: ${problems.length ? '发现 ' + problems.length + ' 处错乱' : '干净'}`)
  problems.slice(0, 4).forEach((p) => console.log(p))
  return problems.length === 0
}

/** 与 shells.ts 的 resolveShell 保持一致 */
const SHELLS = {
  pwsh: {
    command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${profilePath}'`],
    env: {}
  },
  cmd: {
    command: process.env.COMSPEC ?? 'cmd.exe',
    args: [],
    env: { PROMPT: '$E]7;file:///$P$E\\$P$G' }
  }
}

async function runCase({ cols, rows, resizeTo, label, startupResize, shell = 'pwsh' }) {
  const term = new Terminal({ cols, rows, scrollback: 300, allowProposedApi: true })
  const sentry = new Sentry({
    to_terminal: (o) => term.write(new Uint8Array(o)),
    sender: () => {},
    on_detect: () => {},
    on_retract: () => {}
  })
  // 与 LocalPtyManager 一致：应用里 pty 总是先以 80x24 启动
  const spawnCols = startupResize ? 80 : cols
  const spawnRows = startupResize ? 24 : rows
  const spec = SHELLS[shell]
  const p = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color',
    cols: spawnCols,
    rows: spawnRows,
    cwd: homedir(),
    env: { ...process.env, ...spec.env }
  })
  p.onData((c) => sentry.consume(Buffer.from(c, 'utf8')))

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const typeSlowly = async (text) => {
    for (const ch of text) {
      p.write(ch)
      await wait(60)
    }
    await wait(250)
    p.write('\r')
  }

  if (startupResize) {
    // 复刻应用启动竞态：pty 先以 80x24 起，TerminalPanel 挂载后 fit() 到真实尺寸，
    // 此时 shell 正在画启动横幅和第一个提示符，conpty 被迫重排
    await wait(300)
    term.resize(cols, rows)
    p.resize(cols, rows)
  }

  await wait(1400)
  await typeSlowly('ls')
  await wait(500)
  await typeSlowly('$x = 1')
  await wait(400)

  if (resizeTo) {
    // 模拟应用挂载 / 布局变化时的 fit()
    term.resize(resizeTo.cols, resizeTo.rows)
    p.resize(resizeTo.cols, resizeTo.rows)
    await wait(700)
    await typeSlowly('echo AFTER-RESIZE')
    await wait(500)
  }

  const finalCols = resizeTo ? resizeTo.cols : cols
  const finalRows = resizeTo ? resizeTo.rows : rows
  const lines = collectScreen(term, finalRows)
  const ok = checkScreen(lines, label)

  if (!ok && process.env.SHOW) {
    console.log('  --- 屏幕内容 ---')
    lines.forEach((t, y) => t.trim() && console.log(`  ${String(y).padStart(2)}|${t}`))
  }

  p.kill()
  return ok
}

const cases = [
  { cols: 100, rows: 30, label: '100x30 常规' },
  { cols: 80, rows: 24, label: '80x24 常规' },
  { cols: 70, rows: 20, label: '70x20 窄窗' },
  { cols: 100, rows: 30, resizeTo: { cols: 80, rows: 24 }, label: '100x30 → 80x24 缩小' },
  { cols: 80, rows: 24, resizeTo: { cols: 120, rows: 40 }, label: '80x24 → 120x40 放大' },
  // 矮窗口：ls 输出必然溢出，触发 conpty 滚动 + 双行提示符
  { cols: 100, rows: 15, label: '100x15 矮窗滚动' },
  { cols: 80, rows: 12, label: '80x12 矮窗滚动' },
  { cols: 100, rows: 15, resizeTo: { cols: 60, rows: 10 }, label: '100x15 → 60x10 溢出+缩小' }
]

// 启动竞态场景：pty 以 80x24 起，很快被 fit 成不同尺寸
const startupCases = [
  { cols: 100, rows: 30, startupResize: true, label: '启动竞态 80x24→100x30' },
  { cols: 120, rows: 35, startupResize: true, label: '启动竞态 80x24→120x35' },
  { cols: 60, rows: 20, startupResize: true, label: '启动竞态 80x24→60x20' }
]

// cmd 场景（当前默认 shell）：dir 代替 ls
const cmdCases = [
  { cols: 100, rows: 30, shell: 'cmd', label: 'cmd 100x30 常规' },
  { cols: 80, rows: 20, shell: 'cmd', label: 'cmd 80x20 常规' },
  { cols: 100, rows: 30, startupResize: true, shell: 'cmd', label: 'cmd 启动竞态 80x24→100x30' }
]

let allOk = true
for (const c of [...cases, ...startupCases, ...cmdCases]) {
  const ok = await runCase(c)
  if (!ok) allOk = false
}
console.log('\n结论:', allOk ? '全部场景通过' : '存在错乱场景')
process.exit(allOk ? 0 : 1)

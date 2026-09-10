/**
 * 隔离实验：cmd 带我们的 PROMPT 启动后不打任何命令，dump 启动画面。
 * 用来判断「启动就出现目录列表」是否由 PROMPT 注入引起。
 * 用法：node scripts/verify-cmd-startup.mjs [withPrompt|noPrompt]
 */
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')

const mode = process.argv[2] ?? 'withPrompt'
const COLS = 146
const ROWS = 48

const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true })
const env = { ...process.env }
if (mode === 'withPrompt') env.PROMPT = '$E]7;file:///$P$E\\$P$G'
else delete env.PROMPT

// 复刻应用：先以 80x24 起，随后 resize 到真实尺寸
const p = pty.spawn(process.env.COMSPEC ?? 'cmd.exe', [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: homedir(),
  env
})
p.onData((c) => term.write(new Uint8Array(Buffer.from(c, 'utf8'))))

await new Promise((r) => setTimeout(r, 400))
term.resize(COLS, ROWS)
p.resize(COLS, ROWS)

await new Promise((r) => setTimeout(r, 2000))

const buf = term.buffer.active
console.log(`=== ${mode} 启动画面（不打任何命令）===`)
for (let y = 0; y < ROWS; y++) {
  const line = buf.getLine(buf.baseY + y)
  const text = line ? line.translateToString(true) : ''
  if (text.trim()) console.log(`${String(y).padStart(2)}| ${text}`)
}
p.kill()
process.exit(0)

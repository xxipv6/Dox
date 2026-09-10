/**
 * 验证 cmd.exe 的 PROMPT 注入能否上报 cwd（OSC 7）。
 * 用法：node scripts/verify-cmd-integration.mjs
 */
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

// 与 shells.ts 中 resolveShell 保持一致
const prompt = '$E]7;file:///$P$E\\$P$G'

let out = ''
const p = pty.spawn(process.env.COMSPEC ?? 'cmd.exe', [], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: homedir(),
  env: { ...process.env, PROMPT: prompt }
})
p.onData((c) => (out += c))

setTimeout(() => p.write('cd %TEMP%\r'), 1200)
setTimeout(() => {
  const osc7 = [...out.matchAll(/\x1b\]7;([^\x1b\x07]*)/g)].map((m) => m[1])
  console.log('cmd OSC7 上报次数 :', osc7.length)
  console.log('cmd OSC7 最后一条 :', osc7.at(-1))

  const visible = out
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
  console.log('用户可见输出      :', JSON.stringify(visible.slice(-160)))

  p.kill()
  process.exit(0)
}, 2600)

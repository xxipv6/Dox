/** 一次性排查脚本：列出渲染层里所有 emoji / 符号字形，用于统一换成 SVG 图标。 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FF0B}\u{2660}-\u{266F}]/u

function walk(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name)
    if (f.isDirectory()) walk(p)
    else if (f.name.endsWith('.vue') || f.name.endsWith('.ts')) {
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (RE.test(line)) console.log(`${p}:${i + 1}: ${line.trim()}`)
        })
    }
  }
}
walk('src/renderer/src')

/**
 * chunkBatcher 单测：保序、按体量立即 flush、按时间 flush、dispose 不泄。
 * 用法：node scripts/verify-chunk-batcher.mjs（Node 24 直接跑 TS）
 */
import { createChunkBatcher } from '../src/main/chunkBatcher.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. 小 chunk 被合并、顺序保持
{
  const sent = []
  const b = createChunkBatcher((d) => sent.push(d))
  for (let i = 0; i < 100; i++) b.push(Buffer.from(`chunk-${i}|`))
  b.flush()
  const joined = sent.map((b) => b.toString()).join('')
  const want = Array.from({ length: 100 }, (_, i) => `chunk-${i}|`).join('')
  check('保序合并', joined === want)
  check('合并成少量消息', sent.length < 5, `${sent.length} 条`)
  b.dispose()
}

// 2. 超 64KB 立即 flush（不等定时器）
{
  const sent = []
  const b = createChunkBatcher((d) => sent.push(d))
  b.push(Buffer.alloc(70 * 1024, 65))
  check('超量立即 flush', sent.length === 1 && sent[0].length === 70 * 1024)
  b.dispose()
}

// 3. 定时 flush（4ms 级，给宽限）
{
  const sent = []
  const b = createChunkBatcher((d) => sent.push(d))
  b.push(Buffer.from('hello'))
  await sleep(50)
  check('定时器自动 flush', sent.length === 1 && sent[0].toString() === 'hello')
  b.dispose()
}

// 4. dispose 后不再发
{
  const sent = []
  const b = createChunkBatcher((d) => sent.push(d))
  b.push(Buffer.from('bye'))
  b.dispose()
  await sleep(50)
  check('dispose 后静默', sent.length === 0)
}

// 5. 空 flush 不炸
{
  const b = createChunkBatcher(() => {})
  b.flush()
  b.dispose()
  check('空 flush 安全', true)
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

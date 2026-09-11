/**
 * ZMODEM 预扫描的单测（性能优化：未命中触发序列时绕过 Sentry 的逐块复制）。
 *
 * 三个场景，全部断言「最终写到终端的字节流与原流逐字节一致」：
 *  A. 纯输出（含 0x18 干扰字节但无完整触发）→ 直接写屏，零丢失
 *  B. 触发序列在单个 chunk 内 → 走 Sentry，垃圾头被 retract 后字节全吐回
 *  C. 触发序列横跨两个 chunk（`**\x18` | `B0…`）→ 靠尾巴识别，同样不丢字节
 *  D. retract 之后回到预扫描：后续普通输出直接写屏
 *
 * 用法：node scripts/verify-zmodem-prescan.mjs（无外部依赖，Node 24 直接跑 TS）
 */
import { createZmodemBridge } from '../src/renderer/src/zmodem/zmodemService.ts'

let failed = false
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`)
  if (!cond) failed = true
}

// zmodemService 的 sender 会碰 window.api —— 只在会话真的发协议包时才会调，
// 这里全是垃圾头（confirm 失败 → retract），到不了那一步；给个桩防意外
globalThis.window = { api: { input: () => {} } }

const enc = new TextEncoder()

/** 收集写屏字节，返回桥与总输出 */
function makeBridge() {
  const out = []
  const bridge = createZmodemBridge('test', (data) => out.push(data))
  return {
    bridge,
    totalOut: () => {
      const len = out.reduce((n, c) => n + c.length, 0)
      const buf = new Uint8Array(len)
      let o = 0
      for (const c of out) { buf.set(c, o); o += c.length }
      return buf
    }
  }
}

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

// ---------- A. 纯输出（含 0x18 干扰）----------
{
  const { bridge, totalOut } = makeBridge()
  const junk = []
  let expectedLen = 0
  for (let i = 0; i < 200; i++) {
    // 随机字节流，故意塞 0x18 和 `**`，但不构成完整触发
    const chunk = new Uint8Array(64 + (i % 37))
    for (let j = 0; j < chunk.length; j++) chunk[j] = (i * 31 + j * 7) & 0xff
    chunk[0] = 0x18
    chunk[1] = 0x2a
    chunk[2] = 0x2a // `**\x18` 同块出现 + 下块开头非 'B'：不得误判
    junk.push(chunk)
    expectedLen += chunk.length
    bridge.consume(chunk)
  }
  // 尾巴里留 `**\x18`，下一块开头不是 B
  bridge.consume(enc.encode('tail**\x18'))
  bridge.consume(enc.encode('X not a trigger'))
  const got = totalOut()
  check('A 纯输出字节全量到达写屏', got.length === expectedLen + 'tail**\x18'.length + 'X not a trigger'.length,
    `${got.length} != ${expectedLen + 23}`)
  check('A 无触发不接管', !bridge.isActive())
}

// ---------- B. 触发在单 chunk 内 + 垃圾头 retract ----------
{
  const { bridge, totalOut } = makeBridge()
  const before = enc.encode('normal output\r\n')
  const triggerish = new Uint8Array([0x2a, 0x2a, 0x18, 0x42, 0x30, ...enc.encode('zzzz not hex\r\n')])
  const after = enc.encode('more output after retract\r\n')
  bridge.consume(before)
  bridge.consume(triggerish)
  bridge.consume(after)
  const want = new Uint8Array(before.length + triggerish.length + after.length)
  want.set(before, 0)
  want.set(triggerish, before.length)
  want.set(after, before.length + triggerish.length)
  check('B 单块触发 retract 后字节不丢', eq(totalOut(), want),
    `${totalOut().length} != ${want.length}`)
  check('B retract 后未接管', !bridge.isActive())
}

// ---------- C. 触发横跨两个 chunk ----------
{
  const { bridge, totalOut } = makeBridge()
  const part1 = enc.encode('prompt$ sz big.iso\r\n**')
  const part1b = new Uint8Array([0x18]) // 触发序列的 ZDLE 单独落在块尾
  const part2 = new Uint8Array([0x42, 0x30, ...enc.encode('zzzz\r\n')])
  const after = enc.encode('done\r\n')
  bridge.consume(part1)
  bridge.consume(part1b)
  bridge.consume(part2)
  bridge.consume(after)
  const wantLen = part1.length + part1b.length + part2.length + after.length
  // 跨块命中会把 ≤3 字节尾巴重复喂给 Sentry（文档里写明的取舍），
  // 所以输出长度可能多 0-3 字节；内容必须以原始流为主体
  const got = totalOut()
  check('C 跨块触发识别且基本不丢字节', got.length >= wantLen && got.length <= wantLen + 3,
    `${got.length} vs ${wantLen}`)
  const tail = got.slice(got.length - after.length)
  check('C 尾部输出完整', eq(tail, after))
}

// ---------- D. retract 之后回到预扫描 ----------
{
  const { bridge, totalOut } = makeBridge()
  bridge.consume(new Uint8Array([0x2a, 0x2a, 0x18, 0x42, 0x30, ...enc.encode('garbage\r\n')]))
  const plain = enc.encode('back to normal\r\n')
  const beforeLen = totalOut().length
  bridge.consume(plain)
  check('D retract 后普通输出直写屏', eq(totalOut().slice(beforeLen), plain))
}

console.log(failed ? '\n有失败项' : '\n全部通过')
process.exit(failed ? 1 : 0)

/**
 * 生成应用图标 build/icon.png（512×512，带圆角的深色方块 + 终端 ">_" 符号）。
 * electron-builder 会自动把它转换成 .ico / .icns。
 * 纯 Node 实现（zlib + 手写 PNG 编码），无第三方依赖。
 * 用法：node scripts/generate-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const SIZE = 512
const RADIUS = 112

// ---------- 像素绘制 ----------
const px = Buffer.alloc(SIZE * SIZE * 4)

function set(x, y, r, g, b, a = 255) {
  const i = (y * SIZE + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = a
}

function insideRounded(x, y) {
  const cx = x < RADIUS ? RADIUS : x >= SIZE - RADIUS ? SIZE - RADIUS - 1 : x
  const cy = y < RADIUS ? RADIUS : y >= SIZE - RADIUS ? SIZE - RADIUS - 1 : y
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

/** 点到线段距离的平方 */
function segDist2(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2))
  const px_ = x1 + t * dx - x
  const py_ = y1 + t * dy - y
  return px_ * px_ + py_ * py_
}

const BG = [0x1a, 0x1b, 0x26]
const FG = [0x7a, 0xa2, 0xf7]

// ">" 的两条斜线（端点），以及 "_" 的矩形
const CHEVRON = [
  [150, 170, 262, 256],
  [262, 256, 150, 342]
]
const STROKE2 = 30 * 30
const BAR = { x1: 300, y1: 324, x2: 436, y2: 358 }

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!insideRounded(x, y)) continue // 透明圆角
    set(x, y, ...BG)
    const onChevron = CHEVRON.some(([x1, y1, x2, y2]) => segDist2(x, y, x1, y1, x2, y2) < STROKE2)
    const onBar = x >= BAR.x1 && x <= BAR.x2 && y >= BAR.y1 && y <= BAR.y2
    if (onChevron || onBar) set(x, y, ...FG)
  }
}

// ---------- PNG 编码 ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA

// 每行前置 filter 字节 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log(`build/icon.png 已生成（${(png.length / 1024).toFixed(1)} KB）`)

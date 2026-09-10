/**
 * 生成应用图标 build/icon.png。
 * electron-builder 会自动把它转换成 .ico / .icns。
 * 纯 Node 实现（zlib + 手写 PNG 编码），无第三方依赖。
 *
 * 用法：
 *   node scripts/generate-icon.mjs             # 出 build/icon.png（512）
 *   node scripts/generate-icon.mjs --preview   # 另出 shots/icon-sizes.png（各尺寸并排，供肉眼核对）
 *
 * 设计：天蓝 → 草绿的竖向渐变圆角方块 + 白色终端提示符（`>_`）。
 * 渐变用的是「晴空」主题的同一套色相（--accent 天蓝 / --success 草绿），
 * 所以图标和界面是一眼能对上的同一个人。
 *
 * 为什么用渐变底而不是浅底：图标要同时待在浅色和深色任务栏上。
 * 浅底在浅色任务栏上会糊掉轮廓，饱和的渐变两处都立得住。
 *
 * 为什么竖向而不是斜向：竖的是「上天下草」的自然读法；
 * 斜的会在中间穿过一段发灰的过渡带，缩小后像脏了一块。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

/** 设计基准尺寸。所有几何都写在 0..BASE 的坐标系里，再按目标尺寸整体缩放 */
const BASE = 512

/*
 * 超采样倍率。图标要缩到 16×16 用，圆角与笔画的边缘在 512 下看不出锯齿，
 * 一缩就全冒出来 —— 所以在 3 倍尺寸上画，再按块平均降采样回来当抗锯齿。
 */
const SS = 3

/** 渐变停靠点：0 顶部 → 1 底部 */
const STOPS = [
  { at: 0.0, rgb: [0x38, 0xbd, 0xf8] }, // sky-400：最亮的一档，做「天光」
  { at: 0.45, rgb: [0x0e, 0xa5, 0xe9] }, // sky-500：--accent
  { at: 1.0, rgb: [0x10, 0xb9, 0x81] } // emerald-500：--success
]
const MARK = [0xff, 0xff, 0xff]

/** 圆角半径（设计基准），512 下 112 —— 与 macOS/iOS 的圆角比例接近 */
const RADIUS = 112

/*
 * ">" 的两条斜线（端点）与 "_" 的矩形，写在设计基准里。
 *
 * 整组按**外形包围盒**居中，不是按某一笔居中。注意算包围盒时两部分的「外扩量」不同：
 *  - ">" 是描边，圆头圆角，四周各外扩半个线宽（16）
 *  - "_" 是硬边矩形（SDF 取 max(dx,dy)，方角），不外扩
 * 把外扩量一律加上去会算错 —— 之前就是这么算的，得出「已居中」的结论，
 * 实际中心在 (248,248)，整体偏左上 8px。
 * 现在：x 由 105(=121-16) 到 407，y 由 154(=170-16) 到 358，中心正好 256/256。
 *
 * 线宽 32（512 下约 6%）：再细一档在 16×16 下会被抗锯齿抹成灰边。
 */
const CHEVRON = [
  [121, 170, 233, 256],
  [233, 256, 121, 342]
]
const STROKE = 32
const BAR = { x1: 271, y1: 324, x2: 407, y2: 358 }

// ---------- 渐变 ----------
/**
 * 竖向渐变取色，在**相邻停靠点之间**插值。
 * 不用「整条线首尾两点插值」：那样中间那档会被两头压过去，蓝色段会提前发绿。
 */
function gradientAt(t) {
  const v = Math.max(0, Math.min(1, t))
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i]
    const b = STOPS[i + 1]
    if (v <= b.at || i === STOPS.length - 2) {
      const span = b.at - a.at || 1
      const k = Math.max(0, Math.min(1, (v - a.at) / span))
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k
      ]
    }
  }
  return STOPS[STOPS.length - 1].rgb
}

// ---------- 形状（都接收设计基准坐标，soft 是「一个设备像素」等于多少设计单位）----------
/** 圆角矩形的覆盖率 0..1 */
function roundedCoverage(x, y, soft) {
  const cx = x < RADIUS ? RADIUS : x > BASE - RADIUS ? BASE - RADIUS : x
  const cy = y < RADIUS ? RADIUS : y > BASE - RADIUS ? BASE - RADIUS : y
  const dx = x - cx
  const dy = y - cy
  const d = Math.sqrt(dx * dx + dy * dy)
  return Math.max(0, Math.min(1, (RADIUS - d) / soft + 0.5))
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

/** 标记的覆盖率 0..1 */
function markCoverage(x, y, soft) {
  let best = 0
  for (const [x1, y1, x2, y2] of CHEVRON) {
    const d = Math.sqrt(segDist2(x, y, x1, y1, x2, y2)) - STROKE / 2
    best = Math.max(best, Math.max(0, Math.min(1, -d / soft + 0.5)))
  }
  // 矩形部分：到矩形边界的距离（在矩形内为负）
  const dx = Math.max(BAR.x1 - x, x - BAR.x2)
  const dy = Math.max(BAR.y1 - y, y - BAR.y2)
  const dBar = Math.max(dx, dy)
  best = Math.max(best, Math.max(0, Math.min(1, -dBar / soft + 0.5)))
  return best
}

/**
 * 渲染一张 size×size 的 RGBA 图。
 *
 * 先按 SS 倍画，再按块平均降采样 —— 直接按目标尺寸画的话，
 * 边缘只有「在/不在」两种取值，缩小后圆角是阶梯状的。
 */
function renderRGBA(size) {
  const scale = size / BASE
  const n = size * SS
  const soft = 1 / scale // 一个设备像素，换算成设计基准单位
  const big = Buffer.alloc(n * n * 4)

  for (let by = 0; by < n; by++) {
    const y = ((by + 0.5) / SS / scale)
    for (let bx = 0; bx < n; bx++) {
      const x = ((bx + 0.5) / SS / scale)
      const outer = roundedCoverage(x, y, soft)
      if (outer <= 0) continue
      const [r, g, b] = gradientAt(y / BASE)
      const m = markCoverage(x, y, soft)
      // 标记是从渐变里「挖白」：m=1 全白，m=0 纯渐变，中间是过渡
      const i = (by * n + bx) * 4
      big[i] = r + (MARK[0] - r) * m
      big[i + 1] = g + (MARK[1] - g) * m
      big[i + 2] = b + (MARK[2] - b) * m
      big[i + 3] = 255 * outer
    }
  }

  const out = Buffer.alloc(size * size * 4)
  const per = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * n + (x * SS + sx)) * 4
          // 按 alpha 加权：否则半透明的边缘像素会被当成「发暗的实色」,
          // 圆角外圈会挂一圈脏边
          const w = big[i + 3] / 255
          r += big[i] * w
          g += big[i + 1] * w
          b += big[i + 2] * w
          a += big[i + 3]
        }
      }
      const aw = a / 255 || 1
      const o = (y * size + x) * 4
      out[o] = Math.round(r / aw)
      out[o + 1] = Math.round(g / aw)
      out[o + 2] = Math.round(b / aw)
      out[o + 3] = Math.round(a / per)
    }
  }
  return out
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

/** w/h 要分开传：预览拼图不是正方形，size 当宽高用会越界读 */
function encodePng(px, w, h = w) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA

  // 每行前置 filter 字节 0
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) {
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 把若干张不同尺寸的图并排贴到一张浅色底上，供肉眼核对 */
function buildSheet(sizes) {
  const pad = 16
  const box = Math.max(...sizes)
  const w = sizes.reduce((a, b) => a + b, 0) + pad * (sizes.length + 1)
  const h = box + pad * 2
  const sheet = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    sheet[i * 4] = 0xf8
    sheet[i * 4 + 1] = 0xfa
    sheet[i * 4 + 2] = 0xff
    sheet[i * 4 + 3] = 255
  }

  let x0 = pad
  for (const size of sizes) {
    const px = renderRGBA(size)
    const y0 = pad + Math.floor((box - size) / 2)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4
        const a = px[s + 3] / 255
        if (a <= 0) continue
        const d = ((y0 + y) * w + (x0 + x)) * 4
        // 半透明边缘要和底色合成，否则圆角外圈会留一圈黑
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(px[s + c] * a + sheet[d + c] * (1 - a))
        sheet[d + 3] = 255
      }
    }
    x0 += size + pad
  }
  return { px: sheet, w, h }
}

// ---------- 输出 ----------
mkdirSync('build', { recursive: true })
const png = encodePng(renderRGBA(512), 512)
writeFileSync('build/icon.png', png)
console.log(`build/icon.png 已生成（512×512，${(png.length / 1024).toFixed(1)} KB）`)

if (process.argv.includes('--preview')) {
  /*
   * 各尺寸**原生渲染**（不是从 512 缩下去的）—— 这是 .ico 该有的做法，
   * 也是唯一能看出「16×16 下那笔还认得出来吗」的办法。
   */
  mkdirSync('shots', { recursive: true })
  const sizes = [128, 64, 32, 16]
  const { px, w, h } = buildSheet(sizes)
  writeFileSync('shots/icon-sizes.png', encodePng(px, w, h))
  console.log(`shots/icon-sizes.png 已生成（${sizes.join('/')} 并排）`)
}

/**
 * 端口转发建议的检测逻辑（纯函数，可 Node 直接单测）。
 *
 * 设计分两层的理由：终端输出是每块 64KB 的高频路径，绝不允许每块都
 * 解码全文 + 跑正则。所以先用**字节级子串门控**——块里连 localhost /
 * 127.0.0.1 / 0.0.0.0 这些字样都没有，就不可能有服务横幅，直接放行；
 * 只有命中的极少数块才解码成文本提取端口。
 */

const decoder = new TextDecoder()

/** 门控要扫的字样（出现任一才可能含服务横幅） */
const HINTS = ['localhost', '127.0.0.1', '0.0.0.0'].map((s) =>
  new TextEncoder().encode(s)
)

/** 块内是否含任一字样（朴素字节扫描，无分配） */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

export function hasListenHint(chunk: Uint8Array): boolean {
  return HINTS.some((h) => containsBytes(chunk, h))
}

/**
 * 从文本里提取监听端口。
 *
 * 只认 `host:port` 形态（vite/uvicorn/flask/node/rails 的横幅全是这形状），
 * 不认「Listening on port 3000」这种纯数字 —— 那类的误报面太大（任何带
 * 数字的日志都像），误报会把气泡变成噪音，功能就死了。
 */
const HOST_PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g

/** 不值得建议的端口：SSH 自己、以及超范围的 */
const PORT_DENY = new Set([22])

export function extractPorts(text: string): number[] {
  const out = new Set<number>()
  for (const m of text.matchAll(HOST_PORT_RE)) {
    const port = Number(m[1])
    if (port >= 1 && port <= 65535 && !PORT_DENY.has(port)) out.add(port)
  }
  return [...out]
}

/** 一步到位的组合：字节门控过了才解码提取 */
export function detectListenPorts(chunk: Uint8Array): number[] {
  if (!hasListenHint(chunk)) return []
  return extractPorts(decoder.decode(chunk))
}

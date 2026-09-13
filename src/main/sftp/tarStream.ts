/**
 * tar 流格式（ustar + pax）的纯 JS 读写。
 *
 * 文件夹批量传输的「换引擎」方案：逐文件 SFTP 每个文件要 open/close 两次
 * 往返，5 万小文件就是 10 万次 RTT；tar 流把整棵树变成一条连续字节流，
 * 每文件 0 次往返，直接跑满 SSH 通道窗口（协议层分析见 README）。
 *
 * 两端的分工：
 *  - 上传：这里生成 tar 字节流 → 喂给远端 `tar -xf -` 的 stdin；
 *  - 下载：远端 `tar -cf -` 的 stdout → 这里的解析器边收边解。
 * 本机**不需要**装 tar —— 这也是不 spawn 系统 tar 的原因：macOS bsdtar /
 * Linux gtar / Windows bsdtar 的参数和行为差异全是坑，而且自己写才有
 * 精确到文件的进度。
 *
 * 本模块不碰 IO：写侧只产 Buffer，读侧只回调解析结果，磁盘与通道的
 * 接线都在 TransferManager。
 */

// 显式 .ts 后缀：验证脚本用 Node 24 type stripping 直接 import 本模块，
// 那时没有打包器帮忙补扩展名（tsconfig 已开 allowImportingTsExtensions）
import { join } from 'node:path'
import { sanitizeWinName } from '../fsSafe.ts'

export const TAR_BLOCK = 512

/** 结束标记：两个全零块 */
export function tarTrailer(): Buffer {
  return Buffer.alloc(TAR_BLOCK * 2)
}

export interface TarEntryMeta {
  /** posix 相对路径（目录以 '/' 结尾），如 mydir/sub/a.txt */
  name: string
  size: number
  mode: number
  /** 秒级 mtime */
  mtime: number
  isDir: boolean
}

/** 文件内容之后的 512 对齐填充长度（0 ~ 511） */
export function tarPadSize(size: number): number {
  return (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK
}

/**
 * tar 条目落到本地磁盘的归位：防 tar slip（`..` 越界段直接拒整条），
 * 各段过 Windows 净化。绝对路径按相对处理（首段空串被滤掉，落在 base 内，
 * 无害）。返回 null = 调用方跳过该条目（数据仍要读完，别污染解析状态）。
 */
export function safeLocalJoin(base: string, rel: string): string | null {
  const parts = rel.split('/').filter((p) => p && p !== '.')
  if (!parts.length || parts.some((p) => p === '..')) return null
  return join(base, ...parts.map(sanitizeWinName))
}

// ---- 写侧 ----

/** ustar 头部 size 字段能容纳的最大值（11 位八进制）；超过要走 pax size 记录 */
const MAX_OCTAL_SIZE = 0o77777777777

function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const s = Math.floor(value).toString(8)
  buf.write(s.padStart(length - 1, '0'), offset, length - 1, 'ascii')
  buf[offset + length - 1] = 0
}

function writeName(buf: Buffer, name: string, offset: number, length: number): void {
  const b = Buffer.from(name, 'utf8')
  b.copy(buf, offset, 0, Math.min(b.length, length))
}

/**
 * pax 扩展头记录：`<len> <key>=<value>\n`，len 含自身。
 * 注意 len 是**字节**长度（UTF-8 编码后的），按字符数算会在中文名上截断。
 * len 的位数会影响 len 本身，迭代到稳定。
 */
function paxRecord(key: string, value: string): string {
  const tail = ` ${key}=${value}\n`
  const tailBytes = Buffer.byteLength(tail, 'utf8')
  let len = tailBytes + 1
  for (;;) {
    const next = String(len).length + tailBytes
    if (next === len) return `${len}${tail}`
    len = next
  }
}

/** 尝试把长路径拆进 ustar 的 prefix(155)/name(100) 两段；放不下返回 null */
function splitUstarName(name: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(name, 'utf8') <= 100) return { prefix: '', name }
  const parts = name.split('/')
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    const rest = parts.slice(i).join('/')
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(rest, 'utf8') <= 100) {
      return { prefix, name: rest }
    }
  }
  return null
}

function makeHeader(
  name: string,
  prefix: string,
  size: number,
  mode: number,
  mtime: number,
  typeflag: string
): Buffer {
  const buf = Buffer.alloc(TAR_BLOCK)
  writeName(buf, name, 0, 100)
  writeOctal(buf, mode & 0o7777, 100, 8)
  writeOctal(buf, 0, 108, 8) // uid：非 root 解压时本就会被忽略
  writeOctal(buf, 0, 116, 8) // gid
  writeOctal(buf, size, 124, 12)
  writeOctal(buf, mtime, 136, 12)
  // chksum 字段先填空格再算和
  buf.fill(0x20, 148, 156)
  buf.write(typeflag, 156, 1, 'ascii')
  buf.write('ustar\0' + '00', 257, 8, 'ascii')
  writeName(buf, 'dox', 265, 32) // uname/gname 只是装饰
  writeName(buf, 'dox', 297, 32)
  writeOctal(buf, 0, 329, 8)
  writeOctal(buf, 0, 337, 8)
  writeName(buf, prefix, 345, 155)
  let sum = 0
  for (let i = 0; i < TAR_BLOCK; i++) sum += buf[i]
  const chk = sum.toString(8).padStart(6, '0')
  buf.write(chk, 148, 6, 'ascii')
  buf[154] = 0
  buf[155] = 0x20
  return buf
}

/**
 * 一个条目的全部头部块（通常就一个 512 块；长名/超大文件多一个 pax 块）。
 * 目录条目之后没有数据块；文件条目之后由调用方写 size 字节 + tarPadSize 填充。
 */
export function tarHeaderBlocks(entry: TarEntryMeta): Buffer[] {
  const split = splitUstarName(entry.name)
  const needPaxPath = split === null
  const needPaxSize = !entry.isDir && entry.size > MAX_OCTAL_SIZE
  const blocks: Buffer[] = []

  if (needPaxPath || needPaxSize) {
    let data = ''
    if (needPaxPath) data += paxRecord('path', entry.name)
    if (needPaxSize) data += paxRecord('size', String(entry.size))
    const dataBuf = Buffer.from(data, 'utf8')
    blocks.push(makeHeader('PaxHeader', '', dataBuf.length, 0o644, entry.mtime, 'x'))
    blocks.push(dataBuf)
    const pad = tarPadSize(dataBuf.length)
    if (pad) blocks.push(Buffer.alloc(pad))
  }

  // pax 在场时头部 name 字段被忽略，交给 writeName 按 100 字节截断即可
  const nameField = needPaxPath ? entry.name : split!.name
  const prefixField = needPaxPath ? '' : split!.prefix
  blocks.push(
    makeHeader(
      nameField,
      prefixField,
      needPaxSize || entry.isDir ? 0 : entry.size,
      entry.mode,
      entry.mtime,
      entry.isDir ? '5' : '0'
    )
  )
  return blocks
}

/** 一个条目在线上的总字节数（头 + 数据 + 填充），用于开传前算出精确总量 */
export function tarEntryBytes(entry: TarEntryMeta): number {
  let n = 0
  for (const b of tarHeaderBlocks(entry)) n += b.length
  if (!entry.isDir) n += entry.size + tarPadSize(entry.size)
  return n
}

// ---- 读侧 ----

export interface TarParsedEntry {
  name: string
  size: number
  isDir: boolean
}

/** 解析结果的消费者；每个回调都可异步（磁盘写），解析器会挨个等 */
export interface TarSink {
  onDir(entry: TarParsedEntry): Promise<void>
  onFileStart(entry: TarParsedEntry): Promise<void>
  onFileData(chunk: Buffer): Promise<void>
  onFileEnd(): Promise<void>
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < TAR_BLOCK; i++) if (block[i] !== 0) return false
  return true
}

function readCString(block: Buffer, offset: number, length: number): string {
  let end = offset
  const limit = offset + length
  while (end < limit && block[end] !== 0) end++
  return block.toString('utf8', offset, end)
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const s = readCString(block, offset, length).trim()
  return s ? parseInt(s, 8) : 0
}

/**
 * GNU base-256 大数字（默认 gnu 格式对 >8GB 的 size 用它）：
 * 首字节最高位置位，其余按大端二进制读。
 */
function readBase256(block: Buffer, offset: number, length: number): number {
  let value = block[offset] & 0x7f
  for (let i = 1; i < length; i++) value = value * 256 + block[offset + i]
  return value
}

function readSize(block: Buffer): number {
  return block[124] & 0x80 ? readBase256(block, 124, 12) : readOctal(block, 124, 12)
}

/** 解析 pax 数据区的 `<len> <key>=<value>\n` 记录 */
function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let pos = 0
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos)
    if (sp < 0) break
    const len = parseInt(data.toString('ascii', pos, sp), 10)
    if (!Number.isFinite(len) || len <= 0 || pos + len > data.length) break
    const rec = data.toString('utf8', sp + 1, pos + len - 1) // 去掉尾部 \n
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    pos += len
  }
  return out
}

type State =
  | { kind: 'header' }
  | { kind: 'file'; entry: TarParsedEntry; left: number }
  | { kind: 'capture'; left: number; data: Buffer[]; apply: (data: Buffer) => void }
  | { kind: 'pad'; left: number }
  | { kind: 'done' }

/**
 * 增量 tar 解析器。任意大小的 chunk 喂进来，按条目向 sink 回调。
 * 背压由调用方实现（await push 期间暂停读通道即可）。
 *
 * 远端侧兼容性：GNU tar 默认 gnu 格式（长名走 'L'/'K' 块、大数走 base-256），
 * bsdtar/BusyBox 出 pax（'x' 块）—— 两类都认。符号链接等条目跳过数据，
 * 与传输队列「不跟链」的口径一致。
 */
export class TarParser {
  private pending: Buffer = Buffer.alloc(0)
  private state: State = { kind: 'header' }
  /** pax / GNU longname 对下一个真实条目的覆盖 */
  private nextName: string | null = null
  private nextSize: number | null = null

  async push(chunk: Buffer, sink: TarSink): Promise<void> {
    if (this.state.kind === 'done') return
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    await this.drain(sink)
  }

  private take(n: number): Buffer {
    const out = this.pending.subarray(0, n)
    this.pending = this.pending.subarray(n)
    return out
  }

  private async drain(sink: TarSink): Promise<void> {
    for (;;) {
      const st = this.state
      if (st.kind === 'done') return

      if (st.kind === 'file') {
        // 空文件：不进数据态就直接收尾（left=0 时下面的 min 会算出 0 然后死等）
        if (st.left === 0) {
          await sink.onFileEnd()
          this.state = { kind: 'pad', left: tarPadSize(st.entry.size) }
          continue
        }
        const n = Math.min(st.left, this.pending.length)
        if (n === 0) return
        await sink.onFileData(this.take(n))
        st.left -= n
        if (st.left === 0) {
          await sink.onFileEnd()
          this.state = { kind: 'pad', left: tarPadSize(st.entry.size) }
        }
        continue
      }

      if (st.kind === 'capture') {
        if (st.left === 0) {
          st.apply(Buffer.concat(st.data))
          this.state = { kind: 'header' } // 空数据没有填充
          continue
        }
        const n = Math.min(st.left, this.pending.length)
        if (n === 0) return
        st.data.push(this.take(n))
        st.left -= n
        if (st.left === 0) {
          st.apply(Buffer.concat(st.data))
          const size = st.data.reduce((s, b) => s + b.length, 0)
          this.state = { kind: 'pad', left: tarPadSize(size) }
        }
        continue
      }

      if (st.kind === 'pad') {
        if (st.left === 0) {
          this.state = { kind: 'header' }
          continue
        }
        const n = Math.min(st.left, this.pending.length)
        if (n === 0) return
        this.take(n)
        st.left -= n
        if (st.left === 0) this.state = { kind: 'header' }
        continue
      }

      // header
      if (this.pending.length < TAR_BLOCK) return
      const block = this.take(TAR_BLOCK)
      if (isZeroBlock(block)) {
        this.state = { kind: 'done' }
        return
      }
      // 校验和：算和时 chksum 字段按空格计
      let sum = 0
      for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]
      if (sum !== readOctal(block, 148, 8)) {
        throw new Error('tar 流损坏（头部校验和不符）')
      }

      const size = readSize(block)
      const typeflag = String.fromCharCode(block[156] || 0x30) // NUL 视同 '0'（老格式）
      let name = readCString(block, 0, 100)
      // posix magic：prefix 拼回名字；GNU 老格式（'ustar  \0'）没有 prefix
      if (block.toString('ascii', 257, 262) === 'ustar' && block[262] === 0) {
        const prefix = readCString(block, 345, 155)
        if (prefix) name = `${prefix}/${name}`
      }

      if (typeflag === 'x' || typeflag === 'g') {
        // 'x' 覆盖下一个条目；'g' 是全局头，读完忽略
        this.state = {
          kind: 'capture',
          left: size,
          data: [],
          apply: (data) => {
            if (typeflag !== 'x') return
            const recs = parsePax(data)
            if (recs.path) this.nextName = recs.path
            if (recs.size) this.nextSize = parseInt(recs.size, 10)
          }
        }
        continue
      }
      if (typeflag === 'L' || typeflag === 'K') {
        // GNU longname/longlink：数据区就是名字（尾部带 NUL 填充）
        this.state = {
          kind: 'capture',
          left: size,
          data: [],
          apply: (data) => {
            if (typeflag === 'L') {
              const end = data.indexOf(0)
              this.nextName = data.toString('utf8', 0, end < 0 ? data.length : end)
            }
          }
        }
        continue
      }

      const entry: TarParsedEntry = {
        name: this.nextName ?? name,
        size: this.nextSize ?? size,
        isDir: typeflag === '5'
      }
      this.nextName = null
      this.nextSize = null

      if (entry.isDir) {
        await sink.onDir(entry)
        this.state = { kind: 'pad', left: tarPadSize(entry.size) } // 目录 size 恒 0，防御而已
        continue
      }
      if (typeflag === '0') {
        await sink.onFileStart(entry)
        this.state = { kind: 'file', entry, left: entry.size }
        continue
      }
      // 符号链接 / 硬链接 / 设备节点等：跳过数据（不跟链是既定口径）
      this.state = { kind: 'pad', left: entry.size + tarPadSize(entry.size) }
    }
  }
}

/**
 * 分隔文本解析（.csv 逗号 / .tsv Tab 共用），RFC 4180 的宽松实现。
 *
 * 规格刻意写死，别「顺手优化」：
 *   - 引号模式只在**字段首字符**是 `"` 时进入 —— `a"b` 的引号是字面内容；
 *   - 引号内 `""` 是转义的引号；闭合引号后跟的不是分隔符/换行/EOF，
 *     回到字面态继续累积（Excel 的宽松语义）；
 *   - 未闭合引号吃到 EOF 为止；
 *   - **不 trim 任何空白** —— trim 是 CSV 解析最常见的静默数据破坏；
 *   - 只认 `\r\n` 与 `\n` 为记录分隔，单独的 `\r` 按字面（老 Mac 行尾不值得引入风险）；
 *   - 引号字段内的换行是内容，不是记录分隔；
 *   - 结尾的换行串剥掉后不产空记录；**中间**空行产 `[""]` 一条记录；
 *   - BOM（开头 U+FEFF）剥一次。
 */

/** 剥掉结尾的全部 \r\n / \n（尾部空行不产记录），开头剥一次 BOM */
function stripTailAndBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/(?:\r\n|\n)+$/, '')
}

export function parseDelimited(text: string, delimiter: string): string[][] {
  if (text === '') return []
  const src = stripTailAndBom(text)
  if (src === '') return []

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let atFieldStart = true // 处于字段开头：唯一允许引号开启的位置
  let inQuotes = false

  while (i < src.length) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        // "" = 转义引号；否则出引号态（下一字符交给字面态判定）
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        field += ch
        i++
      }
      continue
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true
      atFieldStart = false
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      atFieldStart = true
      i++
      continue
    }
    if (ch === '\n' || (ch === '\r' && src[i + 1] === '\n')) {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      atFieldStart = true
      i += ch === '\r' ? 2 : 1
      continue
    }
    field += ch
    atFieldStart = false
    i++
  }
  // EOF 收尾：剥过尾换行，这里必有悬空字段
  row.push(field)
  rows.push(row)
  return rows
}

/** 列标：0→A … 25→Z 26→AA（26 进制但无零位，Excel 同款） */
export function colLabel(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/** 最大列数（状态栏 N 行 × M 列 与表格共用） */
export function maxCols(rows: string[][]): number {
  return rows.reduce((m, r) => Math.max(m, r.length), 0)
}

/** POSIX sh 单引号 quoting；SFTP/容器 tar 与互传共用同一实现。 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

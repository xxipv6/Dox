/** 业务中立的 .tar.gz 命名规则；本地与远端文件面板共用同一口径。 */
export function archiveBaseName(names: string[]): string {
  if (!names.length) throw new Error('没有可打包的项')
  return names.length === 1 ? `${names[0]}.tar.gz` : `打包-${names.length}项.tar.gz`
}

/** 撞名避让：`foo.tar.gz` → `foo-2.tar.gz` → `foo-3.tar.gz`。 */
export function withSuffix(name: string, n: number): string {
  if (n < 2) return name
  return name.replace(/\.tar\.gz$/, `-${n}.tar.gz`)
}

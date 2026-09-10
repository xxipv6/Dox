import { posix } from 'node:path'

/**
 * SFTP「打包」的命令构造与命名规则。
 *
 * 在远端当前目录把选中项打成一个 .tar.gz —— 不下载、不落地本地，
 * 包就出现在面板里（下不需要另点「下载」）。这是文件管理器的常规写操作，
 * 与新建文件夹 / 重命名同类，不碰「远端无感」红线（不装 agent、不建服务）。
 *
 * 全是纯函数，不碰会话 —— 可以被脚本直接 import 单测（Node 24 type stripping）。
 */

/**
 * 双引号转义。
 *
 * 远端命令统一走 `/bin/sh -c '…'` 包裹（登录 shell 可能是 fish/csh，
 * 见 container/runtime.ts 的说明），**脚本内不能出现单引号**，
 * 所以内层引用一律双引号，转义 `\ " $ \`` 这四个在双引号里仍有意义的字符。
 * 文件名含换行直接拒绝 —— 不是不能转，是这种人需要更大的教训而不是一个压缩包。
 */
export function dq(s: string): string {
  if (/[\n\r]/.test(s)) {
    throw new Error(`文件名含换行，无法打包：${JSON.stringify(s)}`)
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`
}

/**
 * 包名：单项用本名（`foo` → `foo.tar.gz`），多项用「打包-N项」。
 * 撞名由调用方用 withSuffix 加序号，这里只管基础名。
 */
export function archiveBaseName(names: string[]): string {
  if (!names.length) throw new Error('没有可打包的项')
  return names.length === 1 ? `${names[0]}.tar.gz` : `打包-${names.length}项.tar.gz`
}

/** 撞名避让：`foo.tar.gz` → `foo-2.tar.gz` → `foo-3.tar.gz` */
export function withSuffix(name: string, n: number): string {
  if (n < 2) return name
  return name.replace(/\.tar\.gz$/, `-${n}.tar.gz`)
}

/**
 * 打包命令。`cd` 进父目录再打相对名，包内的成员名才是干净的
 * `a.txt`、`dir/…` 而不是一串绝对路径。
 *
 * `--` 收尾选项区：文件名可以合法地以 `-` 开头（GNU tar 与 busybox tar 都认）。
 * tar 成功时 stdout 为空，报错走 stderr + 非零退出码，execCapture 都会带回来。
 */
export function buildArchiveCommand(parent: string, target: string, names: string[]): string {
  if (!parent.startsWith('/')) {
    throw new Error(`远端路径必须是绝对路径：${parent}`)
  }
  if (!names.length) throw new Error('没有可打包的项')
  return `/bin/sh -c 'cd ${dq(parent)} && tar -czf ${dq(target)} -- ${names.map(dq).join(' ')}'`
}

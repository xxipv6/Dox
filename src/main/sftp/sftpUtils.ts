import { posix } from 'node:path'
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'

/** ssh2 回调式 API 的 Promise 封装，SftpService 与 TransferManager 共用 */

export function readdirP(sftp: SFTPWrapper, dir: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
  })
}

export function statP(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, attrs) => (err ? reject(err) : resolve(attrs)))
  })
}

export function readFileP(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, buf) => (err ? reject(err) : resolve(buf)))
  })
}

/**
 * 写入远端文件。sftp.writeFile 对已存在文件是「打开+截断」而非新建，
 * 因此属主与权限位都会被保留 —— 编辑 /etc/nginx/nginx.conf 后不会变成
 * 当前用户私有、也不会丢掉可执行位。
 */
export function writeFileP(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (err) => (err ? reject(err) : resolve()))
  })
}

export function mkdirP(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
  })
}

export function unlinkP(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
  })
}

export function rmdirP(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))
  })
}

/** 递归创建远端目录，已存在的层级静默跳过 */
export async function mkdirRemoteRecursive(sftp: SFTPWrapper, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean)
  let cur = ''
  for (const part of parts) {
    cur += '/' + part
    try {
      await mkdirP(sftp, cur)
    } catch {
      // EEXIST 或权限不足都忽略，后续写入会暴露真正的错误
    }
  }
}

/** 本地相对路径（Windows 反斜杠）转为 posix 相对路径 */
export function toPosixRel(rel: string): string {
  return rel.split('\\').join('/')
}

export { posix }

import { posix } from 'node:path'
import type { Attributes, FileEntryWithStats, SFTPWrapper } from 'ssh2'

/** ssh2 回调式 API 的 Promise 封装，SftpService 与 TransferManager 共用 */

export function readdirP(sftp: SFTPWrapper, dir: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
  })
}

export function statP(sftp: SFTPWrapper, path: string): Promise<Attributes> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, attrs) => (err ? reject(err) : resolve(attrs)))
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

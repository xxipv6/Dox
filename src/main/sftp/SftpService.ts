import type { SFTPWrapper } from 'ssh2'
import { MAX_EDITABLE_BYTES, type FileEntry, type RemoteFileContent } from '../../shared/types'
import { isLocalId } from '../../shared/sessionId'
import type { SessionManager } from '../ssh/SessionManager'
import { execCapture } from '../ssh/remoteExec'
import { archiveBaseName, buildArchiveCommand, withSuffix } from './archive'
import * as localFs from '../local/localFs'
import {
  mkdirP,
  posix,
  readFileP,
  readdirP,
  rmdirP,
  statP,
  unlinkP,
  writeFileP
} from './sftpUtils'

/** 容器文件操作桥：带 containerName 的调用经 agent fs 协议走（AgentManager.call） */
export interface AgentFsBridge {
  call(sessionId: string, containerName: string, method: string, params: unknown): Promise<unknown>
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

/**
 * SFTP 文件操作。远端一律按 posix 语义处理路径（服务器基本是 Linux），
 * 与本地平台无关。
 *
 * containerName 给了就是**容器内**文件操作：SFTP 摸不到容器的 mount
 * namespace，这条路经容器里的 dox-agent（fs_* 方法，Dev Containers 式）。
 *
 * sessionId 带 local- 前缀就是**本机**文件操作：本地终端标签的文件面板，
 * 与远端共用同一套 IPC，这里分流到 node:fs（见 local/localFs.ts）。
 */
export class SftpService {
  constructor(
    private readonly sessions: SessionManager,
    private readonly agentFs?: AgentFsBridge
  ) {}

  private fs(sessionId: string, containerName: string, method: string, params: unknown): Promise<unknown> {
    if (!this.agentFs) throw new Error('容器文件通道不可用')
    return this.agentFs.call(sessionId, containerName, method, params)
  }

  async list(sessionId: string, dir: string, containerName?: string): Promise<FileEntry[]> {
    if (isLocalId(sessionId)) return localFs.list(dir)
    if (containerName) {
      const res = (await this.fs(sessionId, containerName, 'fs_list', { path: dir })) as {
        entries: { name: string; is_dir: boolean; is_symlink: boolean; size: number; mtime: number }[]
      }
      return res.entries
        .map((e) => ({
          name: e.name,
          path: posix.join(dir, e.name),
          isDir: e.is_dir,
          isSymlink: e.is_symlink,
          size: e.size,
          mtime: e.mtime
        }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    }
    const sftp = await this.sessions.sftp(sessionId)
    const items = await readdirP(sftp, dir)
    return items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => ({
        name: i.filename,
        path: posix.join(dir, i.filename),
        isDir: i.attrs.isDirectory(),
        isSymlink: i.attrs.isSymbolicLink(),
        size: i.attrs.size,
        mtime: i.attrs.mtime
      }))
      // 目录优先，同类按名称排序
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  }

  async realpath(sessionId: string, path: string, containerName?: string): Promise<string> {
    if (isLocalId(sessionId)) return localFs.realpath(path)
    if (containerName) {
      // 容器没有「家目录」概念，面板落地在 /；cwd 跟随由终端侧 OSC 7 提供
      return path === '.' ? '/' : path
    }
    const sftp = await this.sessions.sftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.realpath(path, (err, resolved) => (err ? reject(err) : resolve(resolved)))
    })
  }

  /**
   * 探一下路径是文件还是目录（终端里 Ctrl+点击路径的「智能分发」用）。
   * 不存在 / 不可读 / 已断开都返回 null —— 终端输出里的路径可能只是长得像，
   * 点开没有结果不算错误，不值得抛给用户。
   */
  async stat(sessionId: string, path: string, containerName?: string): Promise<{ isDir: boolean } | null> {
    if (isLocalId(sessionId)) return localFs.stat(path)
    try {
      if (containerName) {
        const res = (await this.fs(sessionId, containerName, 'fs_stat', { path })) as { is_dir: boolean }
        return { isDir: res.is_dir }
      }
      const sftp = await this.sessions.sftp(sessionId)
      const attrs = await statP(sftp, path)
      return { isDir: attrs.isDirectory() }
    } catch {
      return null
    }
  }

  async mkdir(sessionId: string, path: string, containerName?: string): Promise<void> {
    if (isLocalId(sessionId)) return localFs.mkdir(path)
    if (containerName) {
      await this.fs(sessionId, containerName, 'fs_mkdir', { path })
      return
    }
    const sftp = await this.sessions.sftp(sessionId)
    await mkdirP(sftp, path)
  }

  /**
   * 路径所在文件系统的用量。三路按目标能力选：
   *  - 容器 → agent fs_usage（容器有自己的 mount namespace，宿主的 statvfs 看不到里面）
   *  - 宿主机 → OpenSSH 的 statvfs@openssh.com SFTP 扩展（不需要装任何东西）
   * 都不行返回 null —— 用量条是加分项不是刚需，调用方藏起来即可，不值得报错。
   */
  async diskUsage(
    sessionId: string,
    path: string,
    containerName?: string
  ): Promise<{ total: number; used: number; avail: number; mount?: string } | null> {
    if (isLocalId(sessionId)) return localFs.diskUsage(path)
    try {
      if (containerName) {
        const r = (await this.fs(sessionId, containerName, 'fs_usage', { path })) as {
          total: number
          used: number
          avail: number
          mount?: string
        }
        return r
      }
      const sftp = await this.sessions.sftp(sessionId)
      return await new Promise((resolve) => {
        sftp.ext_openssh_statvfs(path, (err, info) => {
          if (err || !info) return resolve(null)
          const frsize = Number(info.f_frsize) || Number(info.f_bsize) || 0
          const total = frsize * Number(info.f_blocks)
          const avail = frsize * Number(info.f_bavail)
          if (!total) return resolve(null)
          resolve({ total, used: total - frsize * Number(info.f_bfree), avail })
        })
      })
    } catch {
      return null
    }
  }

  /**
   * 打包：在远端**当前目录**把选中项打成 .tar.gz，返回包的路径。
   *
   * 不下载、不写本地 —— 下载有专门的入口，这里解决的是「先在远端归置成
   * 一个包」这件事本身（比如要在远端转移、或之后再决定下不下载）。
   *
   * 大目录打包可能远超 execCapture 默认的 10s 上限，给 5 分钟；
   * 期间渲染进程在 await —— 失败会把 tar 的 stderr 原文带回去。
   */
  async archive(sessionId: string, paths: string[], containerName?: string): Promise<string> {
    if (isLocalId(sessionId)) return localFs.archive(paths)
    if (!paths.length) throw new Error('没有选中任何项')
    const parent = posix.dirname(paths[0])
    const names = paths.map((p) => posix.basename(p))
    for (const p of paths) {
      if (posix.dirname(p) !== parent) {
        throw new Error('只能打包同一目录下的项')
      }
    }

    // 撞名避让：foo.tar.gz → foo-2.tar.gz → …（打包不是覆盖别人文件的理由）
    const base = archiveBaseName(names)

    if (containerName) {
      // 容器里没有 tar 保证（distroless 连 shell 都没有）——
      // 打包由容器里的 agent 用 Go 标准库完成（fs_archive），什么镜像都能打
      let target = base
      for (let n = 2; ; n++) {
        try {
          await this.fs(sessionId, containerName, 'fs_stat', { path: posix.join(parent, target) })
          target = withSuffix(base, n)
        } catch {
          break
        }
      }
      const res = (await this.fs(sessionId, containerName, 'fs_archive', {
        parent,
        names,
        target: posix.join(parent, target)
      })) as { path: string }
      return res.path
    }

    const sftp = await this.sessions.sftp(sessionId)
    const client = this.sessions.getClient(sessionId)
    if (!client) throw new Error('会话已断开，无法打包')

    let target = base
    for (let n = 2; ; n++) {
      try {
        await statP(sftp, posix.join(parent, target))
        target = withSuffix(base, n)
      } catch {
        break
      }
    }

    await execCapture(client, buildArchiveCommand(parent, target, names), {
      timeoutMs: 300_000
    })
    // 打包期间若发生重连，结果已落在旧连接那侧 —— 提示用户刷新确认，别装没事
    if (this.sessions.getClient(sessionId) !== client) {
      throw new Error('打包期间连接发生了变更，请刷新目录确认结果')
    }
    return posix.join(parent, target)
  }

  async rename(sessionId: string, from: string, to: string, containerName?: string): Promise<void> {
    if (isLocalId(sessionId)) return localFs.rename(from, to)
    if (containerName) {
      await this.fs(sessionId, containerName, 'fs_rename', { from, to })
      return
    }
    const sftp = await this.sessions.sftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  /**
   * 读取文本文件供内置编辑器显示。
   * 先看大小再看内容：大文件直接拒绝（读进来会卡死渲染进程），
   * 开头 8KB 含 NUL 字节则判定为二进制，不交给编辑器（否则是满屏乱码）。
   */
  async readText(sessionId: string, path: string, containerName?: string): Promise<RemoteFileContent> {
    if (isLocalId(sessionId)) return localFs.readText(path)
    if (containerName) {
      const st = (await this.fs(sessionId, containerName, 'fs_stat', { path })) as { size: number }
      if (st.size > MAX_EDITABLE_BYTES) {
        throw new Error(
          `文件 ${formatSize(st.size)} 超过 ${formatSize(MAX_EDITABLE_BYTES)} 上限，` +
            `无法在内置编辑器中打开。请用「下载」后本地查看。`
        )
      }
      const res = (await this.fs(sessionId, containerName, 'fs_read', { path })) as {
        data: string
        size: number
        mtime: number
        binary: boolean
      }
      const buf = Buffer.from(res.data, 'base64')
      return {
        path,
        content: res.binary ? '' : buf.toString('utf8'),
        size: res.size,
        mtime: res.mtime,
        binary: res.binary
      }
    }
    const sftp = await this.sessions.sftp(sessionId)
    const attrs = await statP(sftp, path)

    if (attrs.size > MAX_EDITABLE_BYTES) {
      throw new Error(
        `文件 ${formatSize(attrs.size)} 超过 ${formatSize(MAX_EDITABLE_BYTES)} 上限，` +
          `无法在内置编辑器中打开。请用「下载」后本地查看。`
      )
    }

    // 整个缓冲区扫 NUL（不是只扫开头）：文件已经读进内存了，全量扫描更准，
    // 也能挡掉「前 8KB 恰好没有 NUL 的二进制」
    const buf = await readFileP(sftp, path)
    const binary = buf.includes(0)

    return {
      path,
      content: binary ? '' : buf.toString('utf8'),
      size: attrs.size,
      mtime: attrs.mtime,
      binary
    }
  }

  /**
   * 写回文本文件，返回新的 mtime。
   *
   * expectedMtime 是打开文件时的 mtime：如果远端在此期间被别处改过，
   * 直接覆盖会无声吞掉别人的改动（改配置文件的经典事故），所以这里
   * 拒绝写入，让用户自己决定。
   */
  async writeText(
    sessionId: string,
    path: string,
    content: string,
    expectedMtime?: number,
    containerName?: string
  ): Promise<number> {
    if (isLocalId(sessionId)) return localFs.writeText(path, content, expectedMtime)
    if (containerName) {
      const res = (await this.fs(sessionId, containerName, 'fs_write', {
        path,
        data: Buffer.from(content, 'utf8').toString('base64'),
        expected_mtime: expectedMtime ?? null
      })) as { mtime: number }
      return res.mtime
    }
    const sftp = await this.sessions.sftp(sessionId)

    if (expectedMtime !== undefined) {
      const current = await statP(sftp, path).catch(() => null)
      if (current && current.mtime !== expectedMtime) {
        throw new Error(
          '该文件在你编辑期间已被外部修改。请关闭后重新打开确认最新内容，' +
            '避免覆盖掉别人的改动。'
        )
      }
    }

    await writeFileP(sftp, path, Buffer.from(content, 'utf8'))
    const attrs = await statP(sftp, path)
    return attrs.mtime
  }

  /**
   * 删除文件（unlink）或目录（递归）。
   * 递归删除是高危操作，渲染进程必须显式确认后才允许调用目录分支。
   * 符号链接一律按文件 unlink，绝不跟随进入。
   */
  async remove(sessionId: string, path: string, isDir: boolean, containerName?: string): Promise<void> {
    if (isLocalId(sessionId)) return localFs.remove(path, isDir)
    if (containerName) {
      await this.fs(sessionId, containerName, 'fs_delete', { path, recursive: isDir })
      return
    }
    const sftp = await this.sessions.sftp(sessionId)
    if (!isDir) {
      await unlinkP(sftp, path)
      return
    }
    const items = await readdirP(sftp, path)
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue
      const child = posix.join(path, item.filename)
      if (item.attrs.isSymbolicLink() || !item.attrs.isDirectory()) {
        await unlinkP(sftp, child)
      } else {
        await this.remove(sessionId, child, true)
      }
    }
    await rmdirP(sftp, path)
  }
}

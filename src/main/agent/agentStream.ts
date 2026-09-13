/**
 * 容器传输的直通道：agent ≥0.4.0 的分块流式读写。
 *
 * 取代「SFTP → 宿主机 /tmp 中转 → docker cp」两段接力：
 *  - 少一次宿主机落盘（中转目录、清理竞态全没了）
 *  - 进度是真进度（逐块更新 transferred）
 *  - distroless 容器也能传（docker cp 依赖宿主侧 docker CLI 通道，这条完全不碰）
 *
 * 1MB 一块：NDJSON + base64 膨胀后约 1.4MB/行，agent 侧 scanner 上限 4MB，安全。
 *
 * 滑动窗口 6 块在途：协议带 offset（agent 侧 WriteAt/ReadAt），块乱序到达
 * 完全安全，而串行 await 的吞吐是 1MB/RTT —— 20ms 链路 50MB/s、100ms 链路
 * 只剩 10MB/s。6 路在途把窗口铺满，与 SFTP 传输的 48 路管道同一思路
 * （这里每块还要 base64+JSON，CPU 开销大，窗口不必那么大）。
 */
import fs from 'node:fs/promises'
import type { AgentManager } from '../agent/AgentManager'

const CHUNK = 1024 * 1024
/** 上传/下载各自的在途块数上限；内存 ≈ WINDOW × (1MB + base64 1.4MB) ≈ 15MB */
const WINDOW = 6
/** 与 TransferManager 的取消哨兵同文案（run() 按它判定「已取消」而不是「失败」） */
export const STREAM_CANCELED = '__transfer_canceled__'

export interface AgentStreamIO {
  upload(
    localPath: string,
    remotePath: string,
    onProgress: (transferred: number) => void,
    isCanceled: () => boolean
  ): Promise<void>
  download(
    remotePath: string,
    localPath: string,
    onProgress: (transferred: number) => void,
    isCanceled: () => boolean
  ): Promise<void>
}

export function createAgentStreamIO(
  agents: AgentManager,
  sessionId: string,
  containerName: string
): AgentStreamIO {
  const call = <T>(method: string, params: unknown): Promise<T> =>
    agents.call(sessionId, containerName, method, params) as Promise<T>

  return {
    async upload(localPath, remotePath, onProgress, isCanceled) {
      /*
       * 断点续传：begin 的 tmp 名按目标路径确定性生成，上次失败留下的半截
       * tmp 会被认出来（existing_size），从断点接着写。
       * 取消与失败的待遇不同：取消 = 用户明确不要了 → abort 清掉 tmp；
       * 失败 = 网络断了之类 → tmp 留着，下次重传自动续上。
       * existing_size 比本地文件还大 = tmp 是另一个来源的残留，作废重来。
       */
      const localSize = (await fs.stat(localPath)).size
      let tmp: string
      let offset: number
      const begin = await call<{ tmp: string; existing_size?: number }>('fs_write_begin', { path: remotePath })
      tmp = begin.tmp
      offset = begin.existing_size ?? 0
      if (offset > localSize) {
        await call('fs_write_abort', { tmp }).catch(() => undefined)
        const again = await call<{ tmp: string; existing_size?: number }>('fs_write_begin', { path: remotePath })
        tmp = again.tmp
        offset = 0
      }
      try {
        const fh = await fs.open(localPath, 'r')
        // 窗口化并发写：块自带 offset，乱序落盘安全；进度按已确认字节累计
        let readPos = offset
        const startOffset = offset
        let confirmed = 0
        let failure: Error | null = null
        try {
          const worker = async (): Promise<void> => {
            const buf = Buffer.allocUnsafe(CHUNK)
            for (;;) {
              if (isCanceled()) throw new Error(STREAM_CANCELED)
              if (failure) return
              // 分配块位置：同步代码段，worker 之间不会交错
              const pos = readPos
              if (pos >= localSize) return
              const len = Math.min(CHUNK, localSize - pos)
              readPos += len
              const { bytesRead } = await fh.read(buf, 0, len, pos)
              if (bytesRead === 0) return // 传输期间本地文件被截短
              if (failure) return
              try {
                await call('fs_write_chunk', {
                  tmp,
                  offset: pos,
                  data: buf.subarray(0, bytesRead).toString('base64')
                })
              } catch (err) {
                if (!failure) failure = err as Error
                return
              }
              confirmed += bytesRead
              onProgress(startOffset + confirmed)
            }
          }
          await Promise.all(Array.from({ length: WINDOW }, worker))
        } finally {
          await fh.close()
        }
        // failure 的写入全在闭包里，TS 流分析到这已把它窄化成 null —— 断言绕开
        const writeErr = failure as Error | null
        if (writeErr) throw writeErr
        await call('fs_write_commit', { tmp, path: remotePath })
      } catch (err) {
        // 取消才清 tmp；失败留半截给下次续传
        if (err instanceof Error && err.message === STREAM_CANCELED) {
          await call('fs_write_abort', { tmp }).catch(() => undefined)
        }
        throw err
      }
    },

    async download(remotePath, localPath, onProgress, isCanceled) {
      /*
       * 下载续传：本地已有半截就从它的长度接着读（对端 read_chunk 带 offset）。
       * 本地比远端还大 = 不是同一个东西的残留，清空重来。
       * 没有存远端 mtime 可比对，「远端中途变了」不在守卫范围内（注释即口径）。
       *
       * 窗口化并发读：remoteSize 要第一次响应才知道，此前允许最多 WINDOW 个
       * 探路请求（小文件会多发几个越界读，返回空+eof，无害有界）。响应乱序
       * 到达没关系：块带 offset，写本地也用 offset。
       */
      let offset = 0
      try {
        offset = (await fs.stat(localPath)).size
      } catch { /* 没下载过 */ }
      const fh = await fs.open(localPath, offset > 0 ? 'r+' : 'w')
      try {
        let readPos = offset
        const startOffset = offset
        let remoteSize = -1
        let eofSeen = false
        let confirmed = 0
        let maxWritten = offset
        let failure: Error | null = null

        const worker = async (): Promise<void> => {
          for (;;) {
            if (isCanceled()) throw new Error(STREAM_CANCELED)
            if (failure || eofSeen) return
            // 分配块位置：同步代码段，worker 之间不会交错
            const pos = readPos
            if (remoteSize >= 0 && pos >= remoteSize) return
            readPos += CHUNK

            let r: { data: string; eof: boolean; size: number }
            try {
              r = await call('fs_read_chunk', { path: remotePath, offset: pos, length: CHUNK })
            } catch (err) {
              if (!failure) failure = err as Error
              return
            }
            if (failure) return
            remoteSize = r.size
            const buf = Buffer.from(r.data, 'base64')
            if (buf.length > 0) {
              await fh.write(buf, 0, buf.length, pos)
              confirmed += buf.length
              if (pos + buf.length > maxWritten) maxWritten = pos + buf.length
              onProgress(startOffset + confirmed)
            }
            if (r.eof || buf.length === 0) {
              eofSeen = true
              return
            }
          }
        }
        await Promise.all(Array.from({ length: WINDOW }, worker))

        // failure 的写入全在闭包里，TS 流分析到这已把它窄化成 null —— 断言绕开
        const readErr = failure as Error | null
        if (readErr) throw readErr
        // 本地半截比远端新文件还长：截掉多出来的尾巴
        if (remoteSize >= 0 && maxWritten > remoteSize) await fh.truncate(remoteSize)
      } finally {
        await fh.close()
      }
    }
  }
}

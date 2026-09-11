/**
 * 容器传输的直通道：agent ≥0.4.0 的分块流式读写。
 *
 * 取代「SFTP → 宿主机 /tmp 中转 → docker cp」两段接力：
 *  - 少一次宿主机落盘（中转目录、清理竞态全没了）
 *  - 进度是真进度（逐块更新 transferred）
 *  - distroless 容器也能传（docker cp 依赖宿主侧 docker CLI 通道，这条完全不碰）
 *
 * 1MB 一块：NDJSON + base64 膨胀后约 1.4MB/行，agent 侧 scanner 上限 4MB，安全。
 */
import fs from 'node:fs/promises'
import type { AgentManager } from '../agent/AgentManager'

const CHUNK = 1024 * 1024
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
      const { tmp } = await call<{ tmp: string }>('fs_write_begin', { path: remotePath })
      try {
        const fh = await fs.open(localPath, 'r')
        try {
          const buf = Buffer.allocUnsafe(CHUNK)
          let offset = 0
          for (;;) {
            if (isCanceled()) throw new Error(STREAM_CANCELED)
            const { bytesRead } = await fh.read(buf, 0, CHUNK, offset)
            if (bytesRead === 0) break
            await call('fs_write_chunk', {
              tmp,
              offset,
              data: buf.subarray(0, bytesRead).toString('base64')
            })
            offset += bytesRead
            onProgress(offset)
          }
        } finally {
          await fh.close()
        }
        await call('fs_write_commit', { tmp, path: remotePath })
      } catch (err) {
        await call('fs_write_abort', { tmp }).catch(() => undefined)
        throw err
      }
    },

    async download(remotePath, localPath, onProgress, isCanceled) {
      // 本地先建/清空目标：半路失败留下半截文件是已知行为（与 SFTP 路径一致，
      // verify-transfer-cancel 的「不留半截」断言只约束取消路径的清理）
      const fh = await fs.open(localPath, 'w')
      try {
        let offset = 0
        for (;;) {
          if (isCanceled()) throw new Error(STREAM_CANCELED)
          const r = await call<{
            data: string
            eof: boolean
            size: number
          }>('fs_read_chunk', { path: remotePath, offset, length: CHUNK })
          const buf = Buffer.from(r.data, 'base64')
          if (buf.length > 0) {
            await fh.write(buf, 0, buf.length, offset)
            offset += buf.length
            onProgress(offset)
          }
          if (r.eof || buf.length === 0) break
        }
      } finally {
        await fh.close()
      }
    }
  }
}

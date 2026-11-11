/**
 * agent 目录归档流：整个目录一条任务，不在目标里创建临时归档。
 *
 * 上传：复用本机 tar 生成层，1MiB 合块、6 块在途；agent 按 offset 排序后解压。
 * 下载：agent 产 tar，数据帧按序到达；本机解析并写盘后才 ack 一个 credit。
 * 取消/通道死亡都结束任务，已完成文件保留，正在写的半截文件删除。
 */
import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentArchiveEvent, AgentManager } from './AgentManager'
import { STREAM_CANCELED } from './agentStream.ts'
import { createStreamCancellation } from './streamCancellation.ts'
import { materializeHardlink } from '../sftp/tarDisk.ts'
import {
  TarParser,
  safeLocalJoin,
  tarEntryBytes,
  tarHeaderBlocks,
  tarPadSize,
  tarTrailer,
  type TarSink
} from '../sftp/tarStream.ts'

const CHUNK = 1024 * 1024
const WINDOW = 6
/** 下载发送窗口：覆盖高延迟链路的带宽时延积；旧 agent 会忽略该可选参数 */
const DOWNLOAD_WINDOW = 16

export interface AgentArchiveEntry {
  path: string
  name: string
  size: number
  mode: number
  mtime: number
  isDir: boolean
}

export interface AgentArchiveIO {
  upload(
    entries: AgentArchiveEntry[],
    remoteDir: string,
    onProgress: (transferred: number) => void,
    isCanceled: () => boolean,
    registerCancel: (cancel: () => void) => () => void
  ): Promise<void>
  download(
    remotePath: string,
    localDir: string,
    onProgress: (transferred: number) => void,
    isCanceled: () => boolean,
    registerCancel: (cancel: () => void) => () => void
  ): Promise<void>
}

export function createAgentArchiveIO(
  agents: AgentManager,
  sessionId: string,
  containerName: string
): AgentArchiveIO {
  const call = <T>(method: string, params: unknown): Promise<T> =>
    agents.call(sessionId, containerName, method, params) as Promise<T>

  return {
    async upload(entries, remoteDir, onProgress, isCanceled, registerCancel) {
      const id = randomUUID()
      const total = entries.reduce((n, entry) => n + tarEntryBytes(entry), 0) + tarTrailer().length
      const ctl = createStreamCancellation(isCanceled, registerCancel, () => call('fs_extract_abort', { id }))
      const inFlight = new Set<Promise<void>>()
      let nextOffset = 0
      let confirmed = 0
      let parts: Buffer[] = []
      let partsSize = 0

      const send = async (chunk: Buffer): Promise<void> => {
        ctl.check()
        if (inFlight.size >= WINDOW) await ctl.wait(Promise.race(inFlight))
        const offset = nextOffset
        nextOffset += chunk.length
        const request = ctl.wait(call('fs_extract_chunk', {
          id,
          offset,
          data: chunk.toString('base64')
        })).then(() => {
          confirmed += chunk.length
          onProgress(confirmed)
        })
        inFlight.add(request)
        // 每个 Promise 都有 rejection handler；真正的原因由 race/all 抛给上传主体。
        void request.then(
          () => inFlight.delete(request),
          () => inFlight.delete(request)
        )
      }

      const push = async (data: Buffer): Promise<void> => {
        let rest = data
        while (rest.length > 0) {
          const take = Math.min(CHUNK - partsSize, rest.length)
          parts.push(rest.subarray(0, take))
          partsSize += take
          rest = rest.subarray(take)
          if (partsSize === CHUNK) {
            const chunk = parts.length === 1 ? parts[0] : Buffer.concat(parts, CHUNK)
            parts = []
            partsSize = 0
            await send(chunk)
          }
        }
      }

      try {
        const beginning = call('fs_extract_begin', { id, path: remoteDir, size: total })
        // begin 与 abort 在 agent 上异步分发；若取消先于 begin 回包，
        // begin 落定后再补一刀，避免远端晚建的会话漏收第一次 abort。
        void beginning.then(
          () => isCanceled() ? call('fs_extract_abort', { id }).catch(() => undefined) : undefined,
          () => undefined
        )
        await ctl.wait(beginning)
        for (const entry of entries) {
          ctl.check()
          for (const block of tarHeaderBlocks(entry)) await push(block)
          if (entry.isDir) continue
          // 只读遍历时的长度：源文件变大不能挤进下一个 tar 条目，
          // 变小则在这里直接失败，而不是等远端收到损坏的归档。
          let readBytes = 0
          const rs = entry.size > 0 ? fs.createReadStream(entry.path, { end: entry.size - 1 }) : null
          try {
            if (rs) {
              for await (const chunk of rs) {
                ctl.check()
                readBytes += (chunk as Buffer).length
                await push(chunk as Buffer)
              }
            }
          } finally {
            rs?.destroy()
          }
          if (readBytes !== entry.size) {
            throw new Error(`源文件大小在传输中发生变化：${entry.path}`)
          }
          const pad = tarPadSize(entry.size)
          if (pad) await push(Buffer.alloc(pad))
        }
        await push(tarTrailer())
        if (partsSize > 0) {
          await send(parts.length === 1 ? parts[0] : Buffer.concat(parts, partsSize))
          parts = []
          partsSize = 0
        }
        await ctl.wait(Promise.all(inFlight))
        ctl.check()
        if (nextOffset !== total) throw new Error(`本地归档大小不一致：${nextOffset}/${total}`)
        await ctl.wait(call('fs_extract_commit', { id }))
      } catch (err) {
        // 不等待在途请求：取消必须立即落定，abort 已由 cancel 发出。
        // 非取消失败同样尽力中止远端，不把回收阻塞在另一条请求后面。
        void call('fs_extract_abort', { id }).catch(() => undefined)
        throw err
      } finally {
        ctl.dispose()
      }
    },

    async download(remotePath, localDir, onProgress, isCanceled, registerCancel) {
      const id = randomUUID()
      const ctl = createStreamCancellation(isCanceled, registerCancel, () => call('fs_archive_cancel', { id }))
      const parser = new TarParser()
      let writer: FileHandle | null = null
      let currentFile: string | null = null
      let transferred = 0

      const closeWriter = async (): Promise<void> => {
        if (!writer) return
        const current = writer
        writer = null
        await current.close()
      }
      const sink: TarSink = {
        async onDir(entry) {
          const target = safeLocalJoin(localDir, entry.name)
          if (target) await fs.promises.mkdir(target, { recursive: true })
        },
        async onFileStart(entry) {
          const target = safeLocalJoin(localDir, entry.name)
          if (!target) {
            currentFile = null
            return
          }
          await fs.promises.mkdir(dirname(target), { recursive: true })
          currentFile = target
          writer = await fs.promises.open(target, 'w')
        },
        async onFileData(chunk) {
          transferred += chunk.length
          onProgress(transferred)
          if (writer) await writer.write(chunk)
        },
        async onFileEnd() {
          await closeWriter()
          currentFile = null
        },
        async onHardlink(entry) {
          await materializeHardlink(localDir, entry)
        }
      }

      // agent 的 credit 上限同时限制这个队列长度；数据按 serve 通道顺序入队，
      // 消费侧只在这里 await，解析/磁盘写完成后再返还 credit。
      const events: AgentArchiveEvent[] = []
      let wake: (() => void) | null = null
      const unregister = agents.setArchiveHandler(sessionId, containerName, id, (event) => {
        events.push(event)
        wake?.()
      })
      const nextEvent = async (): Promise<AgentArchiveEvent> => {
        for (;;) {
          ctl.check()
          const event = events.shift()
          if (event) return event
          await ctl.wait(new Promise<void>((resolve) => {
            wake = resolve
          }))
          wake = null
        }
      }

      try {
        const starting = call('fs_archive_start', { id, path: remotePath, window: DOWNLOAD_WINDOW })
        void starting.then(
          () => isCanceled() ? call('fs_archive_cancel', { id }).catch(() => undefined) : undefined,
          () => undefined
        )
        await ctl.wait(starting)
        for (;;) {
          const event = await nextEvent()
          if (event.type === 'done') {
            if (event.error) throw new Error(event.error)
            break
          }
          if (!event.data) continue
          await parser.push(Buffer.from(event.data, 'base64'), sink)
          ctl.check()
          // ack 只用于归还远端 credit，不是数据正确性的确认点。逐块等待回包会把
          // 整流退化成 1MiB/RTT；异步发出后立即处理已到达的下一块，通道死亡
          // 仍由 onDead 补发 done(error) 让任务失败。
          void call('fs_archive_ack', { id }).catch(() => undefined)
        }
        await closeWriter()
        ctl.check()
      } catch (err) {
        // cancel 已发过远端中止；其他错误也尽力发一次，但都不等待回包。
        void call('fs_archive_cancel', { id }).catch(() => undefined)
        await closeWriter().catch(() => undefined)
        if (currentFile) await fs.promises.unlink(currentFile).catch(() => undefined)
        throw err
      } finally {
        unregister()
        ctl.dispose()
      }
    }
  }
}

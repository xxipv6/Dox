/**
 * 容器传输的 docker cp 通道（TransferManager 的容器态 IO）。
 *
 * 容器与宿主机是两个 mount namespace，SFTP 只能到宿主机 —— 所以容器
 * 传输是两段接力：SFTP 走「本机 ↔ 宿主机 /tmp 中转目录」，
 * docker cp 走「中转目录 ↔ 容器」。docker cp 天然支持目录递归，
 * 但这里按文件级调用（传输队列本来就是按文件展开的），
 * 每个文件 cp 一次，换来逐文件的进度与取消语义。
 */

import { posix } from 'node:path'
import type { Client } from 'ssh2'
import { execCapture } from '../ssh/remoteExec.ts'
import { assertContainerTarget } from './runtime.ts'
import { shQuote } from '../sftp/shQuote.ts'

export interface RawTarIO {
  supportsTar(): Promise<boolean>
  command(remotePath: string): string
}

export interface ContainerTransferIO {
  /** docker cp：from/to 中带 `容器名:` 前缀的一侧是容器路径 */
  cp(from: string, to: string): Promise<void>
  /** 删宿主机上的中转文件/目录（尽力而为，不抛错） */
  rmHostStage(path: string): Promise<void>
  /** 远端容器的原始 tar 快路径；本机容器探测会返回 false */
  rawTar: RawTarIO
}

/** 校验并转义容器路径（容器路径进 shell 命令，双引号包裹 + 转义） */
function dq(s: string): string {
  if (s.includes('\n')) throw new Error('路径不允许换行')
  return s.replace(/(["\\$`])/g, '\\$1')
}

export function createContainerTransferIO(
  getClient: (sessionId: string) => Client | null,
  resolveRuntime: (sessionId: string) => Promise<string | null>,
  sessionId: string,
  containerName: string
): ContainerTransferIO {
  assertContainerTarget(containerName)

  const run = async (cmd: string): Promise<void> => {
    const client = getClient(sessionId)
    if (!client) throw new Error('父会话已断开')
    await execCapture(client, cmd, { timeoutMs: 120_000 })
  }

  // 能力探测只在目录下载真正选择快路径时执行；同一批多选共享一个 Promise，
  // 避免 N 个目录并发发出 N 次相同的 docker exec 探针。单次操作内缓存失败，
  // 下次用户操作会拿到新的 IO 并重试，容器重建后不会被永久粘在旧结果上。
  let rawTarBinary: string | null = null
  let rawTarSupport: Promise<boolean> | undefined

  return {
    rawTar: {
      supportsTar() {
        rawTarSupport ??= (async () => {
          const client = getClient(sessionId)
          if (!client) return false
          rawTarBinary = await resolveRuntime(sessionId)
          if (!rawTarBinary) return false
          await execCapture(client, `${rawTarBinary} exec ${containerName} sh -c 'command -v tar'`, {
            timeoutMs: 5000
          })
          return true
        })().catch(() => false)
        return rawTarSupport
      },
      command(remotePath) {
        if (!rawTarBinary) throw new Error('容器原始整流尚未完成能力探测')
        return (
          `${shQuote(rawTarBinary)} exec -i ${containerName} tar -cf - ` +
          `-C ${shQuote(posix.dirname(remotePath))} -- ${shQuote(posix.basename(remotePath))}`
        )
      }
    },
    async cp(from, to) {
      const binary = await resolveRuntime(sessionId)
      if (!binary) throw new Error('这台远端没有可用的容器运行时')
      await run(`/bin/sh -c '${binary} cp "${dq(from)}" "${dq(to)}"'`)
    },
    async rmHostStage(path) {
      // 中转目录是我们自己建的 /tmp/.dox-stage-*，只准删这个前缀，防误伤
      if (!path.startsWith('/tmp/.dox-stage-')) return
      try {
        await run(`/bin/sh -c 'rm -rf "${dq(path)}"'`)
      } catch {
        /* 尽力而为 */
      }
    }
  }
}

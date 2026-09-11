/**
 * 容器传输的 docker cp 通道（TransferManager 的容器态 IO）。
 *
 * 容器与宿主机是两个 mount namespace，SFTP 只能到宿主机 —— 所以容器
 * 传输是两段接力：SFTP 走「本机 ↔ 宿主机 /tmp 中转目录」，
 * docker cp 走「中转目录 ↔ 容器」。docker cp 天然支持目录递归，
 * 但这里按文件级调用（传输队列本来就是按文件展开的），
 * 每个文件 cp 一次，换来逐文件的进度与取消语义。
 */

import type { Client } from 'ssh2'
import { execCapture } from '../ssh/remoteExec'
import { assertContainerTarget } from './runtime'

export interface ContainerTransferIO {
  /** docker cp：from/to 中带 `容器名:` 前缀的一侧是容器路径 */
  cp(from: string, to: string): Promise<void>
  /** 删宿主机上的中转文件/目录（尽力而为，不抛错） */
  rmHostStage(path: string): Promise<void>
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

  return {
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

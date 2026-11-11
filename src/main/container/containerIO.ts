import type { SessionManager } from '../ssh/SessionManager'
import type { AgentManager } from '../agent/AgentManager'
import type { ContainerManager } from './ContainerManager'
import type { ContainerIO } from '../sftp/TransferManager'
import { ARCHIVE_STREAM_MIN_AGENT_VERSION, CHUNK_STREAM_MIN_AGENT_VERSION, agentVersionOlder } from '../../shared/agentVersion'
import { createAgentArchiveIO } from '../agent/agentArchiveStream'
import { createAgentStreamIO } from '../agent/agentStream'
import { createContainerTransferIO } from './containerTransfer'

/** 容器传输领域组合：docker cp/rawTar + agent fs，并按版本挂直传能力。 */
export async function createContainerIO(
  sessionId: string,
  containerName: string,
  sessions: SessionManager,
  containers: ContainerManager,
  agents: AgentManager
): Promise<ContainerIO> {
  const io: ContainerIO = {
    ...createContainerTransferIO(
      (id) => sessions.getClient(id) ?? null,
      (id) => containers.runtimeBinary(id),
      sessionId,
      containerName
    ),
    mkdirContainer: async (dir) => {
      await agents.call(sessionId, containerName, 'fs_mkdir', { path: dir })
    },
    statContainer: async (path) => {
      const r = (await agents.call(sessionId, containerName, 'fs_stat', { path })) as {
        is_dir: boolean
        size: number
      }
      return { isDir: r.is_dir, size: r.size }
    },
    listContainer: async (dir) => {
      const r = (await agents.call(sessionId, containerName, 'fs_list', { path: dir })) as {
        entries: { name: string; is_dir: boolean; is_symlink: boolean; size: number }[]
      }
      return r.entries.map((e) => ({
        name: e.name,
        isDir: e.is_dir,
        isSymlink: e.is_symlink,
        size: e.size
      }))
    }
  }
  // 状态探测失败只意味着不挂可选快路径，保留原有 docker cp 回退。
  try {
    const st = await agents.status(sessionId, containerName)
    if (st.installed && st.version) {
      if (!agentVersionOlder(st.version, CHUNK_STREAM_MIN_AGENT_VERSION)) {
        io.stream = createAgentStreamIO(agents, sessionId, containerName)
      }
      if (!agentVersionOlder(st.version, ARCHIVE_STREAM_MIN_AGENT_VERSION)) {
        io.archive = createAgentArchiveIO(agents, sessionId, containerName)
      }
    }
  } catch {
    /* 回退接力路径 */
  }
  return io
}

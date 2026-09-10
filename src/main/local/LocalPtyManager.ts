import { randomUUID } from 'node:crypto'
import os from 'node:os'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { WebContents } from 'electron'
import { IpcChannels } from '../../shared/ipc'
import type { TermSize } from '../../shared/types'

/** 本地会话 id 统一前缀，IPC 层按此前缀把 input/resize 路由到本管理器 */
export const LOCAL_ID_PREFIX = 'local-'

interface LocalSession {
  id: string
  pty: IPty
  owner: WebContents
}

/**
 * 本地终端管理器（Wave 形态的基础：应用启动即开本地 shell）。
 * Windows 用 PowerShell（优先 pwsh），macOS/Linux 用 $SHELL 或 bash。
 * 与 SSH 会话共用同一套 IPC 数据通道（id 前缀区分路由）。
 */
export class LocalPtyManager {
  private sessions = new Map<string, LocalSession>()

  spawn(owner: WebContents, term: TermSize): string {
    const id = `${LOCAL_ID_PREFIX}${randomUUID()}`
    const shell = this.detectShell()

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: term.cols,
      rows: term.rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
      // Windows 上直接加载 conpty.dll，绕过 conpty_console_list_agent 的
      // AttachConsole（从终端启动 Electron 时 agent 必挂，终端会无输出）
      useConptyDll: process.platform === 'win32'
    })

    const session: LocalSession = { id, pty: proc, owner }
    this.sessions.set(id, session)

    proc.onData((chunk) => {
      if (!owner.isDestroyed()) owner.send(IpcChannels.sshData, id, chunk)
    })
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      if (!owner.isDestroyed()) {
        owner.send(IpcChannels.sshStatus, { id, status: 'closed', error: `进程退出（code ${exitCode}）` })
      }
    })

    if (!owner.isDestroyed()) {
      owner.send(IpcChannels.sshStatus, { id, status: 'connected' })
    }
    return id
  }

  write(id: string, data: string | Uint8Array): void {
    const proc = this.sessions.get(id)?.pty
    if (!proc) return
    // node-pty 只接受字符串；ZMODEM 等二进制流在本地终端场景罕见，按 utf8 转换
    proc.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.pty.resize(cols, rows)
    } catch {
      // 进程刚好退出时 resize 会抛错，忽略
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    try {
      session.pty.kill()
    } catch {
      /* 已退出 */
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  private detectShell(): string {
    if (process.platform === 'win32') {
      // 默认 cmd.exe（用户偏好）；后续可在设置中切换 PowerShell / Git Bash
      return process.env.DOXX_LOCAL_SHELL ?? 'cmd.exe'
    }
    return process.env.SHELL ?? '/bin/bash'
  }
}

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { app, type WebContents } from 'electron'
import { IpcChannels } from '../../shared/ipc'
import type { LocalShellInfo, TermSize } from '../../shared/types'
import { detectShells, resolveShell } from './shells'

/** 本地会话 id 统一前缀，IPC 层按此前缀把 input/resize 路由到本管理器 */
export const LOCAL_ID_PREFIX = 'local-'

interface LocalSession {
  id: string
  pty: IPty
  owner: WebContents
}

/**
 * 本地终端管理器（Wave 形态的基础：应用启动即开本地 shell）。
 * 按设置里选择的 shell 启动，并注入 shell integration（OSC 7 / OSC 133）。
 * 与 SSH 会话共用同一套 IPC 数据通道（id 前缀区分路由）。
 */
export class LocalPtyManager {
  private sessions = new Map<string, LocalSession>()

  listShells(): LocalShellInfo[] {
    return detectShells()
  }

  spawn(owner: WebContents, term: TermSize, shellId?: string): string {
    const id = `${LOCAL_ID_PREFIX}${randomUUID()}`
    const { command, args, env } = resolveShell(shellId)

    const proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: term.cols,
      rows: term.rows,
      cwd: os.homedir(),
      env: { ...(process.env as Record<string, string>), ...env }
      // 注意：不要设 useConptyDll。实测该选项会让 pty 完全无输出（仅 23 字节
      // 控制序列）。从终端启动 Electron 时 conpty_console_list_agent 的
      // AttachConsole 报错是噪音，不影响 pty 工作，打包后也不出现。
    })

    const session: LocalSession = { id, pty: proc, owner }
    this.sessions.set(id, session)

    proc.onData((chunk) => {
      // 必须发字节而不是字符串：渲染侧的 ZMODEM Sentry 会把非 Array 输入
      // 转成 Uint8Array，而 new Uint8Array(原始字符串) 恒为空数组，会吞掉全部输出
      if (process.env['DOX_DEBUG_PTY']) this.debugLog(`OUT ${JSON.stringify(chunk.slice(0, 300))}`)
      if (!owner.isDestroyed()) owner.send(IpcChannels.sshData, id, Buffer.from(chunk, 'utf8'))
    })
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      if (!owner.isDestroyed()) {
        owner.send(IpcChannels.sshStatus, {
          id,
          status: 'closed',
          error: `进程退出（code ${exitCode}）`
        })
      }
    })

    if (!owner.isDestroyed()) {
      owner.send(IpcChannels.sshStatus, { id, status: 'connected' })
    }
    return id
  }

  /** 临时诊断：把 pty 的进/出字节落盘，用于定位「终端莫名多出内容」这类问题 */
  private debugLog(line: string): void {
    try {
      const path = join(app.getPath('userData'), 'dox-pty-debug.log')
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* 诊断日志失败不影响功能 */
    }
  }

  write(id: string, data: string | Uint8Array): void {
    const proc = this.sessions.get(id)?.pty
    if (process.env['DOX_DEBUG_PTY']) {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      this.debugLog(`IN  ${JSON.stringify(text.slice(0, 200))}`)
    }
    if (!proc) return
    // node-pty 只接受字符串；本地终端不会出现 ZMODEM 二进制流，按 utf8 转换
    try {
      proc.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    } catch {
      // 进程刚好退出时 write 会抛错，忽略
    }
  }

  resize(id: string, cols: number, rows: number): void {
    if (process.env['DOX_DEBUG_PTY']) this.debugLog(`RESIZE -> ${cols}x${rows}`)
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
    const pid = session.pty.pid
    try {
      session.pty.kill()
    } catch {
      /* 已退出 */
    }
    // node-pty 在 Windows 上依赖 conpty_console_list_agent 枚举子进程，
    // 而该 agent 从终端启动时可能崩溃（AttachConsole failed），导致子进程残留。
    // 这里补一刀按进程树清理，确保不留孤儿 shell。
    if (process.platform === 'win32' && pid) {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => undefined)
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}

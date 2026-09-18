import fs from 'node:fs'
import type { WebContents } from 'electron'
import { IpcChannels } from '../../shared/ipc'

/**
 * 本机面板的目录变更监听（Node fs.watch，非递归，逐目录）。
 *
 * 与 agent 的 fs_watch 同一套语义：整组替换（幂等）、事件只报「哪个目录变了」、
 * 300ms 合并一帧。事件经 agent:fsEvent 下行（containerName = null），
 * 渲染层一套代码吃本机/远端两端。
 *
 * fs.watch 由 OS 内核推送（macOS FSEvents / Windows ReadDirectoryChangesW），
 * 不轮询；盯住的只是「看得见的目录」（browse cwd + 树已展开），数量几十个量级。
 *
 * 订阅键是 (WebContents, sessionId) 而不是单 WebContents：一个窗口可以分屏
 * 出多个本机面板（各自一条 local- 会话），按窗口键控会互相整组替换、
 * 任一面板卸载把全窗口的监听清掉。
 */
interface OwnerWatch {
  watchers: Map<string, fs.FSWatcher>
  dirty: Set<string>
  flushAt: NodeJS.Timeout | null
}

const FLUSH_MS = 300

export class LocalFsWatcher {
  /** `${owner.id}:${sessionId}` → 监听状态（owner.id 随 WebContents 销毁即失效，正好做键） */
  private owners = new Map<string, OwnerWatch>()
  /** 每个 WebContents 的 destroyed 监听只需挂一次 */
  private hooked = new WeakSet<WebContents>()

  private keyOf(owner: WebContents, sessionId: string): string {
    return `${owner.id}:${sessionId}`
  }

  /** 整组替换某个订阅者的监听集合（空数组 = 退订） */
  setDirs(owner: WebContents, sessionId: string, dirs: string[]): void {
    const key = this.keyOf(owner, sessionId)
    if (dirs.length === 0) {
      this.unwatch(owner, sessionId)
      return
    }
    let ow = this.owners.get(key)
    if (!ow) {
      ow = { watchers: new Map(), dirty: new Set(), flushAt: null }
      this.owners.set(key, ow)
      if (!this.hooked.has(owner)) {
        this.hooked.add(owner)
        owner.once('destroyed', () => this.unwatchAll(owner))
      }
    }
    const want = new Set(dirs)
    for (const [dir, w] of ow.watchers) {
      if (!want.has(dir)) {
        w.close()
        ow.watchers.delete(dir)
      }
    }
    for (const dir of want) {
      if (ow.watchers.has(dir)) continue
      try {
        const w = fs.watch(dir, () => this.markDirty(key, owner, sessionId, dir))
        w.on('error', () => {
          // 目录被删/权限变化：摘掉即可，监听是加分项不是刚需
          ow.watchers.delete(dir)
          w.close()
        })
        ow.watchers.set(dir, w)
      } catch { /* 目录不存在等：跳过 */ }
    }
  }

  /** 退订某条会话的监听（面板卸载/会话切换） */
  unwatch(owner: WebContents, sessionId: string): void {
    const key = this.keyOf(owner, sessionId)
    const ow = this.owners.get(key)
    if (!ow) return
    for (const w of ow.watchers.values()) w.close()
    if (ow.flushAt) clearTimeout(ow.flushAt)
    this.owners.delete(key)
  }

  /** 窗口销毁：这个 WebContents 的所有会话一并清 */
  private unwatchAll(owner: WebContents): void {
    const prefix = `${owner.id}:`
    for (const key of [...this.owners.keys()]) {
      if (key.startsWith(prefix)) {
        const ow = this.owners.get(key)!
        for (const w of ow.watchers.values()) w.close()
        if (ow.flushAt) clearTimeout(ow.flushAt)
        this.owners.delete(key)
      }
    }
  }

  private markDirty(key: string, owner: WebContents, sessionId: string, dir: string): void {
    const ow = this.owners.get(key)
    if (!ow) return
    ow.dirty.add(dir)
    ow.flushAt ??= setTimeout(() => {
      ow.flushAt = null
      const dirs = [...ow.dirty]
      ow.dirty.clear()
      if (dirs.length && !owner.isDestroyed()) {
        owner.send(IpcChannels.agentFsEvent, sessionId, null, { event: 'fs', dirs })
      }
    }, FLUSH_MS)
    // setTimeout 持有事件循环：面板进程活着无所谓，但别挡应用退出
    ow.flushAt.unref?.()
  }
}

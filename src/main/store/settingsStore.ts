import Store from 'electron-store'
import type { AppSettings } from '../../shared/types'

interface StoreSchema {
  settings: AppSettings | null
  /*
   * 「更新公告已读到的版本」放顶层 key，不进 AppSettings：
   * 渲染层 persist() 是整体覆盖 settings 的，主进程写的字段会被下一次
   * persist 静默抹掉 —— 表现为公告每次都弹。
   */
  lastSeenVersion: string | null
}

/**
 * 应用设置的持久化（终端配色、字体、本地 shell）。
 *
 * 与布局、会话配置一样走主进程 electron-store。**不能**用渲染进程的
 * localStorage：打包后渲染进程从 file:// 加载，Chromium 视其为不透明源，
 * 写入不落盘 —— 表现就是用户改完设置、重启应用全部还原。
 * 详细证据见 LayoutSnapshot 的注释。
 */
export class SettingsStore {
  private store = new Store<StoreSchema>({
    name: 'dox-settings',
    defaults: { settings: null, lastSeenVersion: null }
  })

  /** 从未保存过时返回 null，让渲染进程知道该走默认值 / 迁移 */
  get(): AppSettings | null {
    return this.store.get('settings') ?? null
  }

  set(settings: AppSettings): void {
    this.store.set('settings', settings)
  }

  /** 更新公告读到哪个版本了；null = 首次运行（还没弹过也没记过） */
  getLastSeenVersion(): string | null {
    return this.store.get('lastSeenVersion') ?? null
  }

  setLastSeenVersion(version: string): void {
    this.store.set('lastSeenVersion', version)
  }
}

import Store from 'electron-store'
import type { AppSettings } from '../../shared/types'

interface StoreSchema {
  settings: AppSettings | null
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
    defaults: { settings: null }
  })

  /** 从未保存过时返回 null，让渲染进程知道该走默认值 / 迁移 */
  get(): AppSettings | null {
    return this.store.get('settings') ?? null
  }

  set(settings: AppSettings): void {
    this.store.set('settings', settings)
  }
}

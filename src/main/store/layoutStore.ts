import Store from 'electron-store'
import type { LayoutSnapshot } from '../../shared/types'

interface StoreSchema {
  layout: LayoutSnapshot | null
}

/**
 * 标签布局的持久化。
 *
 * 与 dox-config / dox-known-hosts 一样走 electron-store（落在 userData 下的
 * JSON 文件），而不是渲染进程的 localStorage —— 后者在打包后的 file:// 源下
 * 根本不落盘，见 LayoutSnapshot 的注释。
 */
export class LayoutStore {
  private store = new Store<StoreSchema>({
    name: 'dox-layout',
    defaults: { layout: null }
  })

  get(): LayoutSnapshot | null {
    const snap = this.store.get('layout')
    // 文件被外部改坏时不让应用起不来
    return snap && Array.isArray(snap.tabs) ? snap : null
  }

  set(snapshot: LayoutSnapshot): void {
    this.store.set('layout', snapshot)
  }

  clear(): void {
    this.store.set('layout', null)
  }
}

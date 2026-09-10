import { app } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 「拖出到资源管理器」的本地落脚目录。
 *
 * 拖出本质上绕不开「先下载」：操作系统的拖放协议要的是一个真实存在的文件
 * 路径，渲染进程没法凭远端路径凭空造出一个拖放源。所以远端文件先落到这里，
 * 再由主进程发起原生拖拽。
 *
 * 放在系统临时目录而不是应用数据目录：这是纯中间产物，用户不会想在里面
 * 找东西，系统清理临时目录时顺走也无所谓。
 */
export function dragOutDir(): string {
  return join(app.getPath('temp'), 'dox-drag')
}

/** 退出时清掉，别在用户临时目录里留一堆来路不明的文件 */
export async function clearDragOutDir(): Promise<void> {
  try {
    await rm(dragOutDir(), { recursive: true, force: true })
  } catch {
    // 临时目录清不掉不是需要打扰用户的事
  }
}

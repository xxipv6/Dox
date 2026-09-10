/**
 * Electron 把 ipcMain.handle 抛出的错误重新包装后送到渲染进程，message 形如：
 *   Error invoking remote method 'ssh:connect': Error: All configured authentication methods failed
 * 直接把这句话显示在界面上是给用户看内部实现。这里剥掉包装层，只留真正的原因。
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/

export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(IPC_WRAPPER, '').replace(/^Error:\s*/, '')
}

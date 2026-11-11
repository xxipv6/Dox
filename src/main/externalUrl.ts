export type ExternalUrlOpener = (url: string) => Promise<void>

/**
 * 终端链接与 window.open 共用的唯一外部 URL 出口。
 * 远端输出可控制入参，因此只允许 HTTP(S)，其余 scheme 一律不交给系统协议处理器。
 */
export async function openHttpExternal(url: unknown, openExternal: ExternalUrlOpener): Promise<boolean> {
  if (typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  await openExternal(parsed.toString())
  return true
}

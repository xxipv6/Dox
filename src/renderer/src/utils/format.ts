export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

export function formatTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatPercent(transferred: number, total: number): string {
  if (total <= 0) return '—'
  return `${Math.min(100, Math.round((transferred / total) * 100))}%`
}

/** 编辑器状态栏的修改时间：当天显示 HH:mm，更早显示日期；0（未知）不显示 */
export function formatMtime(epochSeconds: number): string {
  if (!epochSeconds) return ''
  const d = new Date(epochSeconds * 1000)
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

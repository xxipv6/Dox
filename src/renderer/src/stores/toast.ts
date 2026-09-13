import { ref } from 'vue'

export interface ToastItem {
  id: number
  tone: 'error' | 'success' | 'info'
  message: string
}

export const toasts = ref<ToastItem[]>([])
let seq = 0

export function pushToast(message: string, tone: ToastItem['tone'] = 'error', duration = 4500): void {
  const item: ToastItem = { id: ++seq, tone, message }
  toasts.value.push(item)
  if (toasts.value.length > 4) toasts.value.shift()
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((x) => x.id !== item.id)
  }, duration)
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((x) => x.id !== id)
}

import { ref } from 'vue'

export interface ToastAction {
  /** 按钮上的字，用动词（「重试」「查看」），不要写「确定」 */
  label: string
  run: () => void
}

export interface ToastItem {
  id: number
  tone: 'error' | 'success' | 'info'
  message: string
  /** 可操作的动作。有动作的提示条不自动消失 —— 让人来得及点 */
  action?: ToastAction
}

export const toasts = ref<ToastItem[]>([])

/** 有动作的提示条留多久都不合适：用户可能正好在看别处。所以它不自动消失，由人自己关或点掉 */
const STICKY = 0
let seq = 0

/*
 * 什么时候该弹、什么时候不该弹（免得后来人把提示条铺满）。
 *
 * 弹：**结果不在视野里**的事（复制成功）、**失败**（尤其带可操作动作的）、
 *     以及那些「以为成功了其实没有」的静默失败（设置/布局落盘）。
 * 不弹：结果就在原位的操作。删除/重命名/新建/保存之后列表已经刷新了，
 *     再飘一条「已删除」纯属噪声 —— 提示疲劳比「没提示」更伤。
 */
export function pushToast(
  message: string,
  tone: ToastItem['tone'] = 'error',
  duration = 4500,
  action?: ToastAction
): void {
  const item: ToastItem = { id: ++seq, tone, message, action }
  toasts.value.push(item)
  if (toasts.value.length > 4) toasts.value.shift()
  const ttl = action ? STICKY : duration
  if (ttl > 0) {
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((x) => x.id !== item.id)
    }, ttl)
  }
}

/** 点动作按钮：先执行，再把这条收掉（动作通常会让提示失去意义） */
export function runToastAction(id: number): void {
  const item = toasts.value.find((x) => x.id === id)
  if (!item?.action) return
  const action = item.action
  dismissToast(id)
  action.run()
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((x) => x.id !== id)
}

/**
 * 同一件事的失败只提示一次（默认 10 秒冷却）。
 *
 * 用于「会被高频触发的落盘」：拖一次监控面板宽度会写几十次设置，
 * 真失败了就是几十条一模一样的提示。冷却期内后续失败仍然只写 console，
 * 不静默 —— 排查时日志里连得上。
 */
const lastAt = new Map<string, number>()

export function pushToastOnce(
  key: string,
  message: string,
  tone: ToastItem['tone'] = 'error',
  action?: ToastAction,
  cooldownMs = 10_000
): void {
  const now = Date.now()
  if ((lastAt.get(key) ?? 0) + cooldownMs > now) return
  lastAt.set(key, now)
  pushToast(message, tone, 4500, action)
}

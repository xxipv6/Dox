import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ComposeRunEvent, ComposeVerb } from '@shared/types'

/** 一次 compose 动作（输出流式累积在 text 里，底部抽屉实时渲染） */
export interface ComposeRun {
  id: string
  file: string
  verb: ComposeVerb
  status: 'running' | 'ok' | 'err' | 'canceled'
  text: string
}

/**
 * compose 运行的全局状态。
 *
 * 放 store 而不是 FileExplorer 组件里：用户跑完 up 大概率顺手关掉文件面板
 * 去看终端 —— 输出抽屉不能因为发起者卸载就消失。
 */
export const useComposeStore = defineStore('compose', () => {
  const runs = ref<ComposeRun[]>([])
  const visible = ref(false)
  let subscribed = false

  function init(): void {
    if (subscribed) return
    subscribed = true
    window.api.onComposeEvent((ev) => onEvent(ev))
  }

  function onEvent(ev: ComposeRunEvent): void {
    const run = runs.value.find((r) => r.id === ev.id)
    if (!run) return
    if (ev.type === 'data') {
      run.text += ev.text
      return
    }
    run.status = ev.canceled ? 'canceled' : ev.code === 0 ? 'ok' : 'err'
  }

  async function start(opts: {
    sessionId: string
    filePath: string
    fileName: string
    verb: ComposeVerb
    containerName?: string
  }): Promise<void> {
    init()
    const id = await window.api.composeRun(opts.sessionId, opts.filePath, opts.verb, opts.containerName)
    runs.value.push({ id, file: opts.fileName, verb: opts.verb, status: 'running', text: '' })
    visible.value = true
  }

  function cancel(id: string): void {
    window.api.composeCancel(id)
  }

  /** 清掉已了结的运行记录；全清完顺手把抽屉也合上 */
  function clearDone(): void {
    runs.value = runs.value.filter((r) => r.status === 'running')
    if (!runs.value.length) visible.value = false
  }

  return { runs, visible, init, start, cancel, clearDone }
})

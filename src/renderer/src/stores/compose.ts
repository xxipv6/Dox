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

  /*
   * 两条有界纪律（长时间运行的内存护栏）：
   *  - 单条运行的输出只保留尾部 TEXT_CAP 字符（build 全量日志可以上百 MB，
   *    头部进度行没有回看价值）；截断时留一行说明
   *  - 运行记录总数封顶：超出时先丢最老的**已结束**记录
   */
  const TEXT_CAP = 256 * 1024
  const RUN_CAP = 20

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
      if (run.text.length > TEXT_CAP) {
        run.text = `……（前部输出已截断，共收到超过 ${Math.round(TEXT_CAP / 1024)}KB）……\n` + run.text.slice(-TEXT_CAP)
      }
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
    while (runs.value.length > RUN_CAP) {
      const idx = runs.value.findIndex((r) => r.status !== 'running')
      if (idx < 0) break
      runs.value.splice(idx, 1)
    }
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

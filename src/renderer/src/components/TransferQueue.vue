<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TransferTask } from '@shared/types'
import { formatPercent, formatSize } from '../utils/format'
import Icon from './Icon.vue'

const api = window.api
const tasks = ref<TransferTask[]>([])
const collapsed = ref(false)
let unsubscribe: (() => void) | null = null

const activeCount = computed(
  () => tasks.value.filter((t) => t.status === 'pending' || t.status === 'active').length
)

/** 只渲染最近的任务：目录传输可能瞬间产生上千条，全量渲染会卡死界面 */
const MAX_RENDERED = 200
const visibleTasks = computed(() => [...tasks.value].reverse().slice(0, MAX_RENDERED))
const hiddenCount = computed(() => Math.max(0, tasks.value.length - MAX_RENDERED))

const statusText: Record<TransferTask['status'], string> = {
  pending: '排队中',
  active: '传输中',
  done: '完成',
  error: '失败',
  canceled: '已取消'
}

onMounted(async () => {
  tasks.value = await window.api.listTransfers()
  unsubscribe = window.api.onTransferUpdate((list) => {
    tasks.value = list
  })
})

onBeforeUnmount(() => unsubscribe?.())

function progress(t: TransferTask): number {
  // 结束的任务恒满格：空文件（size=0）算出来是 0%，显示成「完成但 0%」像坏了
  if (t.status === 'done') return 100
  return t.size > 0 ? Math.min(100, (t.transferred / t.size) * 100) : 0
}
</script>

<template>
  <div v-if="tasks.length" class="transfer-panel" :class="{ collapsed }">
    <div class="panel-header" @click="collapsed = !collapsed">
      <span>传输队列<template v-if="activeCount">（{{ activeCount }} 进行中）</template></span>
      <span class="header-actions">
        <!--
          文件夹传输会展开成成百上千条任务，逐条点 × 既点不完也点不过来，
          而且目录遍历还在继续吐新任务 —— 取消掉的总会被补上。这里给一个
          总开关：停掉全部任务，并中断还在跑的目录遍历。
        -->
        <button
          v-if="activeCount"
          class="icon-btn danger"
          title="全部取消"
          @click.stop="api.cancelAllTransfers()"
        >
          <Icon name="x" />
        </button>
        <button class="icon-btn" title="清除已结束（完成/失败/取消）" @click.stop="api.clearFinishedTransfers()">
          <Icon name="check-square" />
        </button>
        <button class="icon-btn">
          <Icon :name="collapsed ? 'chevron-up' : 'chevron-down'" />
        </button>
      </span>
    </div>

    <!-- 用 class 而不是 v-if：折叠要能动画，一 v-if 就直接从 DOM 里没了 -->
    <div class="task-list" :class="{ collapsed }">
      <div v-if="hiddenCount" class="more-hint">另有 {{ hiddenCount }} 条较早的任务未显示</div>
      <div v-for="task in visibleTasks" :key="task.id" class="task">
        <Icon
          class="direction"
          :name="task.direction === 'upload' ? 'upload' : 'download'"
          :size="13"
        />
        <div class="task-body">
          <div class="task-name" :title="task.localPath + ' ↔ ' + task.remotePath">
            {{ task.fileName }}
          </div>
          <div class="progress-track">
            <div
              class="progress-bar"
              :class="task.status"
              :style="{ width: progress(task) + '%' }"
            ></div>
          </div>
          <!-- 失败原因内联：tooltip 要悬停才看得见，还会被截断 -->
          <div v-if="task.status === 'error' && task.error" class="task-error" :title="task.error">
            {{ task.error }}
          </div>
        </div>
        <span class="task-status" :class="task.status" :title="task.error">
          {{ statusText[task.status] }}
          {{ task.status === 'active' ? formatPercent(task.transferred, task.size) : '' }}
          <template v-if="task.size > 0 && task.status !== 'pending'">
            · {{ formatSize(task.transferred) }}/{{ formatSize(task.size) }}
          </template>
        </span>
        <button
          v-if="task.status === 'pending' || task.status === 'active'"
          class="icon-btn"
          title="取消"
          @click="api.cancelTransfer(task.id)"
        ><Icon name="x" :size="12" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 底部停靠，不再浮在内容上面。
 *
 * 原先是 position: absolute; right/bottom: 12px; width: 420px; z-index: 10 ——
 * 而 SFTP 面板就在右侧 360px 处，于是队列一出现就把文件列表底部几十行盖住，
 * 那些行双击、悬停、拖拽全部失效，而且看不出是被谁挡的。
 * 现在它占自己的一条高度（折叠时只有标题栏），谁都不遮。
 */
.transfer-panel {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  max-height: 40%;
}
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
  padding: 6px 12px;
  font-size: var(--fs-sm);
  cursor: pointer;
  background: var(--bg-hover);
}
.header-actions {
  display: flex;
  gap: 4px;
}
/*
 * 占满面板剩余高度，上限由 .transfer-panel 的 max-height 控制。
 * 展开/收起走 max-height 过渡；折叠时 max-height: 0 会压过 flex-grow，
 * 所以不需要再单独把 flex 改掉。
 */
.task-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  max-height: 320px;
  transition:
    max-height var(--dur-slow) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.task-list.collapsed {
  max-height: 0;
  opacity: 0;
}
.more-hint {
  padding: 6px 12px;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  border-bottom: 1px solid var(--bg-hover);
}
/*
 * 任务行限宽。
 *
 * 面板改成全宽底部停靠后，一行会横跨整个窗口宽 —— 4px 的进度条被拉成
 * 一整屏的细线，右端的「完成 · 20.0 MB/20.0 MB」离文件名将近一米远，
 * 完全看不出是一件事。限到 720px 后就还是一行正常的列表项。
 */
.task {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: var(--fs-sm);
  border-top: 1px solid var(--bg-hover);
  max-width: 720px;
}
.direction {
  flex-shrink: 0;
  color: var(--fg-muted);
}
.task-body {
  flex: 1;
  min-width: 0;
}
.task-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}
/* 失败原因内联在进度条下面（一行截断，全文在 title） */
.task-error {
  margin-top: 3px;
  font-size: var(--fs-xs);
  color: var(--danger-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.progress-track {
  height: 6px;
  background: var(--border);
  border-radius: var(--r-xs);
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: var(--accent-text);
  transition: width 0.15s;
}
.progress-bar.done {
  background: var(--success-text);
}
.progress-bar.error,
.progress-bar.canceled {
  background: var(--danger-text);
}
.task-status {
  flex-shrink: 0;
  color: var(--fg-muted);
}
.task-status.error {
  color: var(--danger-text);
}
</style>

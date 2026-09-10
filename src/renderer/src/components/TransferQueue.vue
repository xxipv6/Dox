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
        <button class="icon-btn" title="清除已完成" @click.stop="api.clearFinishedTransfers()">
          <Icon name="check-square" />
        </button>
        <button class="icon-btn">
          <Icon :name="collapsed ? 'chevron-up' : 'chevron-down'" />
        </button>
      </span>
    </div>

    <div v-if="!collapsed" class="task-list">
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
  border-top: 1px solid #2a2b3d;
  background: #16161e;
  max-height: 40%;
}
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  background: #1f2335;
}
.header-actions {
  display: flex;
  gap: 4px;
}
/* 占满面板剩余高度，上限由 .transfer-panel 的 max-height 控制 */
.task-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.more-hint {
  padding: 6px 12px;
  font-size: 11px;
  color: #565f89;
  border-bottom: 1px solid #1f2335;
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
  font-size: 12px;
  border-top: 1px solid #1f2335;
  max-width: 720px;
}
.direction {
  flex-shrink: 0;
  color: #565f89;
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
.progress-track {
  height: 6px;
  background: #2a2b3d;
  border-radius: 3px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: #7aa2f7;
  transition: width 0.15s;
}
.progress-bar.done {
  background: #9ece6a;
}
.progress-bar.error,
.progress-bar.canceled {
  background: #f7768e;
}
.task-status {
  flex-shrink: 0;
  color: #565f89;
}
.task-status.error {
  color: #f7768e;
}
</style>

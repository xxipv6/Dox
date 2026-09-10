<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useSessionStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import DeviceDialog from './DeviceDialog.vue'
import ForwardPanel from './ForwardPanel.vue'
import SnippetPanel from './SnippetPanel.vue'
import type { SavedSession } from '@shared/types'

const store = useSessionStore()
const settings = useSettingsStore()

const collapsed = ref(false)
const dialogVisible = ref(false)
const editing = ref<SavedSession | null>(null)
/** 展开显示端口转发 / 快捷命令等次级面板 */
const showTools = ref(false)

onMounted(() => store.refreshSaved())

function openAdd(): void {
  editing.value = null
  dialogVisible.value = true
}

function openEdit(s: SavedSession): void {
  editing.value = s
  dialogVisible.value = true
}

async function remove(s: SavedSession): Promise<void> {
  if (!confirm(`删除设备「${s.name}」？`)) return
  await store.deleteSaved(s.id)
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="sidebar-header">
      <span v-if="!collapsed" class="logo">Dox</span>
      <span class="header-actions">
        <button v-if="!collapsed" class="icon-btn" title="设置" @click="settings.openDialog()">⚙</button>
        <button class="icon-btn" :title="collapsed ? '展开' : '收起'" @click="collapsed = !collapsed">
          {{ collapsed ? '»' : '«' }}
        </button>
      </span>
    </div>

    <template v-if="!collapsed">
      <!-- 设备列表 -->
      <div class="section-title">
        设备
        <button class="icon-btn add-btn" title="添加设备" @click="openAdd">＋</button>
      </div>

      <div class="device-list">
        <div v-if="!store.savedSessions.length" class="empty-hint">
          还没有设备，点右上角 ＋ 添加
        </div>
        <div
          v-for="s in store.savedSessions"
          :key="s.id"
          class="device"
          :title="`${s.username}@${s.host}:${s.port} — 双击连接`"
          @dblclick="store.connectSaved(s)"
        >
          <span class="device-icon">🖥</span>
          <span class="device-info">
            <span class="device-name">
              <span v-if="s.jumpHostId" class="jump-badge" title="经跳板机连接">⛓</span>{{ s.name }}
            </span>
            <span class="device-host">{{ s.username }}@{{ s.host }}:{{ s.port }}</span>
          </span>
          <!-- 同时拦截 click 与 dblclick：只 stop click 的话，连点两下 × 会
               触发整行的 dblclick（去连接），看起来就像「删除没反应」 -->
          <span class="device-actions" @dblclick.stop>
            <button class="icon-btn" title="连接" @click.stop="store.connectSaved(s)">▶</button>
            <button class="icon-btn" title="编辑" @click.stop="openEdit(s)">✎</button>
            <button class="icon-btn danger" title="删除" @click.stop="remove(s)">×</button>
          </span>
        </div>
      </div>

      <!-- 次级工具面板 -->
      <div class="section-title tools-toggle" @click="showTools = !showTools">
        工具
        <span class="chevron">{{ showTools ? '▾' : '▸' }}</span>
      </div>
      <template v-if="showTools">
        <ForwardPanel />
        <SnippetPanel />
      </template>
    </template>

    <DeviceDialog :visible="dialogVisible" :editing="editing" @close="dialogVisible = false" />
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #16161e;
  border-right: 1px solid #2a2b3d;
  padding: 8px;
  overflow-y: auto;
  transition: width 0.15s;
}
.sidebar.collapsed {
  width: 40px;
  align-items: center;
}
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.header-actions {
  display: flex;
  gap: 2px;
}
.logo {
  font-weight: 700;
  font-size: 16px;
  color: #7aa2f7;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #565f89;
  margin: 8px 0 6px;
  text-transform: uppercase;
}
.add-btn {
  font-size: 15px !important;
  color: #7aa2f7 !important;
  line-height: 1;
}
.add-btn:hover {
  color: #9ab8ff !important;
}
.device-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.device {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.device:hover {
  background: #1f2335;
}
.device:hover .device-actions {
  visibility: visible;
}
.device-icon {
  font-size: 14px;
  flex-shrink: 0;
}
.device-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.device-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-host {
  font-size: 11px;
  color: #565f89;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jump-badge {
  margin-right: 3px;
  font-size: 11px;
}
.device-actions {
  visibility: hidden;
  display: flex;
  flex-shrink: 0;
}
.tools-toggle {
  cursor: pointer;
  border-top: 1px solid #2a2b3d;
  padding-top: 10px;
  margin-top: 12px;
}
.chevron {
  font-size: 10px;
}
.empty-hint {
  font-size: 12px;
  color: #565f89;
  padding: 8px 4px;
  line-height: 1.6;
}
.icon-btn {
  background: none;
  border: none;
  color: #565f89;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
}
.icon-btn:hover {
  color: #c0caf5;
}
.icon-btn.danger:hover {
  color: #f7768e;
}
</style>

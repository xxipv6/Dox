<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useSessionStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import DeviceDialog from './DeviceDialog.vue'
import Icon from './Icon.vue'
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

/** 未保存会话的「重新连接」：把地址预填进添加设备弹窗，密码仍需用户输入 */
const prefill = ref<{ host: string; port: number; username: string } | null>(null)

watch(
  () => store.addDevicePrefill,
  (req) => {
    if (!req) return
    editing.value = null
    prefill.value = req
    dialogVisible.value = true
    store.clearAddDeviceRequest()
  }
)

function closeDialog(): void {
  dialogVisible.value = false
  prefill.value = null
}

function openAdd(): void {
  editing.value = null
  prefill.value = null
  dialogVisible.value = true
}

function openEdit(s: SavedSession): void {
  editing.value = s
  prefill.value = null
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
        <button v-if="!collapsed" class="icon-btn" title="设置" @click="settings.openDialog()">
          <Icon name="settings" :size="16" />
        </button>
        <button class="icon-btn" :title="collapsed ? '展开' : '收起'" @click="collapsed = !collapsed">
          <Icon :name="collapsed ? 'chevron-right' : 'panel-left'" :size="16" />
        </button>
      </span>
    </div>

    <template v-if="!collapsed">
      <!-- 设备列表 -->
      <div class="section-title">
        设备
        <button class="icon-btn add-btn" title="添加设备" @click="openAdd">
          <Icon name="plus" :size="15" />
        </button>
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
          <Icon class="device-icon" name="server" :size="15" />
          <span class="device-info">
            <span class="device-name">
              <span v-if="s.jumpHostId" class="jump-badge" title="经跳板机连接">
                <Icon name="link" :size="12" />
              </span>{{ s.name }}
            </span>
            <span class="device-host">{{ s.username }}@{{ s.host }}:{{ s.port }}</span>
          </span>
          <!-- 同时拦截 click 与 dblclick：只 stop click 的话，连点两下 × 会
               触发整行的 dblclick（去连接），看起来就像「删除没反应」 -->
          <span class="device-actions" @dblclick.stop>
            <button class="icon-btn" title="连接" @click.stop="store.connectSaved(s)">
              <Icon name="play" />
            </button>
            <button class="icon-btn" title="编辑" @click.stop="openEdit(s)">
              <Icon name="pencil" />
            </button>
            <button class="icon-btn danger" title="删除" @click.stop="remove(s)">
              <Icon name="x" />
            </button>
          </span>
        </div>
      </div>

      <!-- 次级工具面板 -->
      <div class="section-title tools-toggle" @click="showTools = !showTools">
        工具
        <Icon class="chevron" :name="showTools ? 'chevron-down' : 'chevron-right'" :size="14" />
      </div>
      <template v-if="showTools">
        <ForwardPanel />
        <SnippetPanel />
      </template>
    </template>

    <DeviceDialog
      :visible="dialogVisible"
      :editing="editing"
      :prefill="prefill"
      @close="closeDialog"
    />
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
/* 全局 .icon-btn:hover 要能生效，这里不能加 !important 把颜色锁死 */
.add-btn {
  color: #7aa2f7;
}
.add-btn:hover {
  color: #9ab8ff;
}
.device-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.device {
  position: relative;
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
.device-icon {
  color: #565f89;
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
  display: inline-flex;
  vertical-align: -2px;
  margin-right: 4px;
  color: #7aa2f7;
}
/*
 * 同 FileExplorer：绝对定位悬浮，不用 visibility —— 后者只是不画出来，
 * 照样占着宽度，把设备名和主机地址挤窄。
 */
.device-actions {
  display: none;
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  padding-left: 8px;
  background: #1f2335;
  box-shadow: -8px 0 8px #1f2335;
}
.device:hover .device-actions {
  display: flex;
}
.tools-toggle {
  cursor: pointer;
  border-top: 1px solid #2a2b3d;
  padding-top: 10px;
  margin-top: 12px;
}
.chevron {
  color: #565f89;
}
.empty-hint {
  font-size: 12px;
  color: #565f89;
  padding: 8px 4px;
  line-height: 1.6;
}
</style>

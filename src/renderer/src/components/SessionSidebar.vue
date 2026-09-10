<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useSessionStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import DeviceDialog from './DeviceDialog.vue'
import Icon from './Icon.vue'
import SidebarSection from './SidebarSection.vue'
import ForwardPanel from './ForwardPanel.vue'
import SnippetPanel from './SnippetPanel.vue'
import ContainerPanel from './ContainerPanel.vue'
import type { SavedSession } from '@shared/types'

const store = useSessionStore()
const settings = useSettingsStore()

const collapsed = ref(false)
const dialogVisible = ref(false)
const editing = ref<SavedSession | null>(null)

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
      <!--
        这里**不再**放标记和字标。
        品牌已经由最上面的自绘标题栏承担（那里也有 logo + Dox），
        两处都放就是同一个词在 47px 内出现两遍，看着像没做完。
        这一条现在只剩右侧那排动作按钮。
      -->
      <span class="header-actions">
        <!--
          主题一键切。图标显示的是**将要切到**的目标（当前是亮色就显示月亮），
          和标题文案一致，不会出现「点太阳结果变亮了」这种歧义。
        -->
        <button
          class="icon-btn theme-toggle"
          :title="settings.resolvedTheme === 'dark' ? '切换到亮色主题' : '切换到深色主题'"
          @click="settings.toggleTheme()"
        >
          <Icon :name="settings.resolvedTheme === 'dark' ? 'sun' : 'moon'" :size="16" />
        </button>
        <button v-if="!collapsed" class="icon-btn" title="设置" @click="settings.openDialog()">
          <Icon name="settings" :size="16" />
        </button>
        <button class="icon-btn" :title="collapsed ? '展开' : '收起'" @click="collapsed = !collapsed">
          <Icon :name="collapsed ? 'chevron-right' : 'panel-left'" :size="16" />
        </button>
      </span>
    </div>

    <div v-if="!collapsed" class="sidebar-body">
      <!--
        侧栏只保留一种标题形状（SidebarSection）：可点的行 + 图标 + 箭头。
        原先是一个「工具」大标题下面并排三个同级小标题，四行字视觉重量差不多，
        分不清哪层是分组哪层是内容 —— 现在层级由折叠表达。
      -->
      <SidebarSection title="设备" icon="server" :open="true">
        <template #actions>
          <button class="icon-btn" title="添加设备" @click="openAdd">
            <Icon name="plus" :size="15" />
          </button>
        </template>

        <div class="device-list">
          <div v-if="!store.savedSessions.length" class="empty-hint">
            还没有设备，点右侧 ＋ 添加
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
      </SidebarSection>

      <ForwardPanel />
      <ContainerPanel />
      <SnippetPanel />
    </div>

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
  width: 264px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  transition: width var(--dur-slow) var(--ease-out);
}
.sidebar.collapsed {
  width: 44px;
  align-items: center;
}
/*
 * 应用标题栏：固定高度 + 下边框，和下面的内容切成两块。
 * 原来是整条侧栏一起滚 —— 内容一长，「Dox」和那几个按钮就滚没了，
 * 想切主题还得先滚回顶部。标题栏现在不参与滚动。
 */
.sidebar-header {
  flex-shrink: 0;
  height: 48px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  display: flex;
  align-items: center;
  /* 品牌搬去标题栏之后这里只剩动作按钮，靠右排 */
  justify-content: flex-end;
  border-bottom: 1px solid var(--border);
}
.sidebar.collapsed .sidebar-header {
  height: auto;
  padding: var(--sp-2) 0;
  border-bottom: none;
  flex-direction: column;
  gap: var(--sp-1);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
/*
 * 顶栏那几枚按钮给足点击区：.icon-btn 默认 padding 3px，
 * 配 16px 图标只有约 22px，比这一排的视觉重量小、也比别处的行高小，
 * 点起来要瞄。这里放到 28×28（图标不变，只加留白）。
 */
.sidebar-header .icon-btn {
  width: 28px;
  height: 28px;
  padding: 0;
}
/* 滚动只发生在这一层 */
.sidebar-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-2) var(--sp-2);
}
.device-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.device {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 7px var(--sp-2);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.device:hover {
  background: var(--bg-hover);
}
.device-icon {
  color: var(--fg-muted);
  flex-shrink: 0;
}
.device-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.device-name {
  font-size: var(--fs-md);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-host {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jump-badge {
  display: inline-flex;
  vertical-align: -2px;
  margin-right: var(--sp-1);
  color: var(--accent-text);
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
  padding-left: var(--sp-2);
  background: var(--bg-hover);
  box-shadow: -8px 0 8px var(--bg-hover);
}
.device:hover .device-actions {
  display: flex;
}
.empty-hint {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  padding: var(--sp-2);
  line-height: 1.6;
}
</style>

<script setup lang="ts">
import { useEscapeToClose } from '../composables/useEscapeToClose'
import { useSessionStore, type SessionTab } from '../stores/sessions'
import Icon from './Icon.vue'

/**
 * 标签溢出清单（标签栏右边的 ▾）。
 *
 * 存在的理由很直接：标签栏是横着一条，20 个标签必然有一半在视口外，
 * 而「在视口外」这件事本身没有提示 —— 横向滚动条不难发现，但要点到某个
 * 具体标签仍然得先猜它在哪一边。这个清单把全部标签按顺序列出来，
 * 点一行跳过去，行尾的 ✕ 直接关掉（连续点就是批量关，不用一行一行找）。
 *
 * 它只读 store，不改自己的数据：标签的增删走的都是 store 那套收尾逻辑。
 */
const store = useSessionStore()

/*
 * 选中一行交给父组件处理（激活 + 滚进可视区 + 平铺时交键盘焦点都归 App.vue），
 * 这里不自己改 activeTabId —— 那份逻辑只该有一处。
 */
const emit = defineEmits<{ select: [tab: SessionTab]; close: [] }>()

useEscapeToClose(
  () => true,
  () => emit('close')
)

/** 关标签后**不**关闭清单：连着关几个是常态，每次都要重开就白做了 */
function closeTab(tab: SessionTab): void {
  store.closeTab(tab)
}
</script>

<template>
  <Teleport to="body">
    <!-- 点别处关掉（清单自己在 body 上，所以这一层只负责「点外面」） -->
    <div class="list-backdrop" @mousedown="emit('close')" @contextmenu.prevent="emit('close')"></div>
    <div class="tab-list" @mousedown.stop>
      <div class="tab-list-head">
        <span>全部标签（{{ store.tabs.length }}）</span>
        <span class="tab-list-tip">点一行跳过去，✕ 直接关</span>
      </div>
      <div class="tab-list-body">
        <div
          v-for="tab in store.tabs"
          :key="tab.tabId"
          class="tab-list-row"
          :class="{ current: tab.tabId === store.activeTabId }"
          @click="emit('select', tab)"
        >
          <span class="status-dot" :class="store.tabStatus(tab)"></span>
          <!-- 标题必须与标签栏上那个是同一个串（store.tabLabel），否则对不上号 -->
          <span class="row-title" :title="store.tabLabel(tab)">{{ store.tabLabel(tab) }}</span>
          <button class="row-close" title="关闭这个标签" @click.stop="closeTab(tab)">
            <Icon name="x" :size="12" />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.list-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
}
.tab-list {
  position: fixed;
  z-index: 201;
  /*
   * 贴在标签栏右下角：清单是标签栏的一部分，从标签栏长出来最自然。
   * 用 fixed + top/right 而不是跟着 ▾ 按钮定位 —— 标签栏高度固定 44px，
   * 写死比再算一遍 rect 稳。
   */
  top: 46px;
  right: var(--sp-3);
  width: 320px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  box-shadow: var(--shadow-lg);
}
.tab-list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-secondary);
  font-size: var(--fs-sm);
}
.tab-list-tip {
  color: var(--fg-muted);
}
.tab-list-body {
  overflow-y: auto;
  padding: 4px;
}
.tab-list-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px 8px;
  border-radius: var(--r-xs);
  color: var(--fg);
  font-size: var(--fs-md);
  cursor: pointer;
}
.tab-list-row:hover {
  background: var(--bg-hover);
}
.tab-list-row.current {
  color: var(--accent-text);
  background: var(--accent-soft);
}
.row-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.row-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--r-xs);
  background: none;
  color: var(--fg-muted);
  cursor: pointer;
}
.row-close:hover {
  color: var(--fg-on-accent);
  background: var(--danger-text);
}
</style>

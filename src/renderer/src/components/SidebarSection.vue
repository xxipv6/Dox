<script setup lang="ts">
import { ref } from 'vue'
import Icon, { type IconName } from './Icon.vue'

/**
 * 侧栏的可折叠分区。
 *
 * 抽出来是因为侧栏原先的层级是坏的：一个「工具」大标题下面又并排三个同级
 * 小标题（端口转发 / 容器 / 快捷命令），四行字长得很像、谁也不比谁更"高一档"，
 * 扫一眼分不清哪些是分组、哪些是内容 —— 这就是「看着乱」的来源。
 *
 * 现在侧栏只有一种标题形状：一个可点的行，带图标、标题、可选的徽标与动作按钮，
 * 右侧一个展开箭头。分组层级由**折叠**表达，而不是靠标题的视觉重量去猜。
 */
const props = withDefaults(
  defineProps<{
    title: string
    icon: IconName
    /** 标题右侧的小徽标（如容器运行时「Docker」） */
    badge?: string
    /** 默认是否展开。默认收起，侧栏默认形态才紧凑 */
    open?: boolean
  }>(),
  { open: false }
)

const expanded = ref(props.open)

function toggle(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <section class="side-section">
    <!--
      鼠标上是个按钮，语义上是 disclosure：所以用 div + role 而不是 <button>，
      因为里面还要放真正的按钮（刷新、新建），button 套 button 是非法 HTML。
    -->
    <div
      class="section-head"
      role="button"
      tabindex="0"
      :aria-expanded="expanded"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <Icon class="head-icon" :name="icon" :size="15" />
      <span class="head-label">{{ title }}</span>
      <span v-if="badge" class="head-badge">{{ badge }}</span>
      <span class="head-spacer"></span>
      <!-- stop：不然点刷新/新建会顺带把整个分区收起 -->
      <span v-if="$slots.actions" class="head-actions" @click.stop>
        <slot name="actions" />
      </span>
      <Icon class="head-chevron" :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" />
    </div>

    <div v-show="expanded" class="section-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.side-section {
  margin-bottom: var(--sp-2);
}
.section-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 30px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
  user-select: none;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.section-head:hover {
  background: var(--bg-hover);
}
.head-icon {
  color: var(--fg-muted);
  flex-shrink: 0;
}
.head-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-normal);
  color: var(--accent-text);
  background: var(--accent-soft);
  border-radius: var(--r-pill);
  padding: 1px 6px;
  flex-shrink: 0;
}
.head-spacer {
  flex: 1;
  min-width: var(--sp-1);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  /* 收起状态下也要能看出这里有个可点的东西，但不能喧宾夺主 */
  opacity: 0.75;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.section-head:hover .head-actions {
  opacity: 1;
}
.head-chevron {
  color: var(--fg-muted);
  flex-shrink: 0;
}
.section-body {
  padding: var(--sp-1) 0 var(--sp-1) var(--sp-1);
}
</style>

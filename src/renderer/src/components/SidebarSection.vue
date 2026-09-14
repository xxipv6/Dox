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

/**
 * 展开自己。
 *
 * 给分区头里那些「+ / 新建」按钮用：点 + 是要**添加东西**，而收起状态下
 * 表单在折叠区里，点了等于什么都没发生（用户只能自己去点箭头）。
 * 只提供展开、不提供收起 —— 收起由箭头负责，动作按钮不该把内容藏起来。
 */
function expand(): void {
  expanded.value = true
}

defineExpose({ expand })
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

    <!--
      展开/收起用 grid-template-rows 0fr → 1fr 的纯 CSS 做法，不再用 v-show 硬切：
      硬切是「啪」地出现，用户看不出这块内容是从这个标题下长出来的。
      不用 JS 量高度、也不用 max-height 猜个大值（猜大了收起的头一段会「没反应」）。
      visibility 一并过渡：收起后里面的按钮不再可聚焦（单纯 height:0 还留在 Tab 序列里）。
    -->
    <div class="section-body" :class="{ open: expanded }">
      <div class="section-body-inner">
        <slot />
      </div>
    </div>
  </section>
</template>

<style scoped>
.side-section {
  margin-bottom: var(--sp-3);
}
.section-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 34px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
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
  display: grid;
  grid-template-rows: 0fr;
  visibility: hidden;
  transition:
    grid-template-rows var(--dur-slow) var(--ease-enter),
    visibility var(--dur-slow);
}
.section-body.open {
  grid-template-rows: 1fr;
  visibility: visible;
}
/*
 * 收起时靠这一层裁剪：grid 的行高变了，里面还得自己 overflow:hidden 才不溢出。
 * 内边距必须跟着一起过渡到 0 —— 0fr 只把「行高」压成 0，元素自己的 padding
 * 不受影响，留着会从收起的缝里漏出一条 12px 的空白。
 */
.section-body-inner {
  overflow: hidden;
  min-height: 0;
  padding: 0;
  transition: padding var(--dur-slow) var(--ease-enter);
}
.section-body.open .section-body-inner {
  padding: var(--sp-2) var(--sp-1) var(--sp-1) var(--sp-2);
}
</style>

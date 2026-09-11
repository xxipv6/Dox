<script setup lang="ts">
/**
 * 统一的加载转圈。
 *
 * 之前各处加载态都是一句纯文本（「加载中…」「查询中…」），慢的时候
 * 读起来像「什么都没有」。一个 CSS 转圈 + 可选文字，颜色随 currentColor。
 */
withDefaults(defineProps<{ size?: number; text?: string }>(), { size: 13, text: '' })
</script>

<template>
  <span class="spinner-wrap" role="status">
    <span class="spinner" :style="{ width: `${size}px`, height: `${size}px` }"></span>
    <span v-if="text" class="spinner-text">{{ text }}</span>
  </span>
</template>

<style scoped>
.spinner-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.spinner {
  display: inline-block;
  border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.spinner-text {
  font-size: var(--fs-sm);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

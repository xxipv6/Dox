<script setup lang="ts">
import Icon from './Icon.vue'
import { dismissToast, runToastAction, toasts } from '../stores/toast'
</script>

<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="toast">
      <div v-for="toast in toasts" :key="toast.id" class="toast pop-surface" :class="toast.tone" role="status">
        <Icon
          :name="toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'zap'"
          :size="15"
        />
        <span class="toast-text">{{ toast.message }}</span>
        <!-- 错误提示要能点：只说「失败了」等于没说（HIG：告诉用户能做什么） -->
        <button v-if="toast.action" class="toast-action" @click="runToastAction(toast.id)">
          {{ toast.action.label }}
        </button>
        <button class="toast-close" aria-label="关闭提示" @click="dismissToast(toast.id)">
          <Icon name="x" :size="12" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 54px;
  right: 18px;
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  width: min(420px, calc(100vw - 36px));
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3);
  color: var(--fg);
  border-left: 3px solid var(--accent-text);
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  line-height: var(--lh-base);
  pointer-events: auto;
}
.toast.error {
  border-left-color: var(--danger-text);
}
.toast.success {
  border-left-color: var(--success-text);
}
.toast.error > .icon {
  color: var(--danger-text);
}
.toast.success > .icon {
  color: var(--success-text);
}
.toast-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.toast-action {
  flex-shrink: 0;
  align-self: center;
  padding: 2px var(--sp-2);
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--accent-text);
  font-family: inherit;
  font-size: var(--fs-xs);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.toast-action:hover {
  border-color: var(--accent-text);
  background: var(--accent-soft);
}
.toast-action:active {
  transform: translateY(0.5px);
}
.toast-close {
  /* 从 12px 的 ✕ 放大到 24px 命中区：提示条是要被关掉的东西，
     点不中就只能等它自己走 */
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--fg-muted);
  background: none;
  border: 0;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.toast-close:hover {
  color: var(--fg);
  background: var(--bg-hover);
}
/* 从右上角滑进来：提示条挂在这个角上，从它出现的方向来解释它是从哪来的 */
.toast-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-enter),
    transform var(--dur-base) var(--ease-enter);
}
.toast-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>

<script setup lang="ts">
import Icon from './Icon.vue'
import { dismissToast, toasts } from '../stores/toast'
</script>

<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="toast">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.tone" role="status">
        <Icon :name="toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'zap'" :size="15" />
        <span>{{ toast.message }}</span>
        <button class="toast-close" aria-label="关闭提示" @click="dismissToast(toast.id)"><Icon name="x" :size="12" /></button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 54px;
  right: 18px;
  z-index: 500;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(420px, calc(100vw - 36px));
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 11px 12px;
  color: var(--fg);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent-text);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
  font-size: var(--fs-sm);
  line-height: 1.45;
  pointer-events: auto;
}
.toast.error { border-left-color: var(--danger-text); }
.toast.success { border-left-color: var(--success-text); }
.toast.error > .icon { color: var(--danger-text); }
.toast.success > .icon { color: var(--success-text); }
.toast span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.toast-close { flex-shrink: 0; color: var(--fg-muted); background: none; border: 0; cursor: pointer; padding: 0; }
.toast-close:hover { color: var(--fg); }
.toast-enter-active, .toast-leave-active { transition: opacity 160ms ease, transform 160ms ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(12px); }
</style>

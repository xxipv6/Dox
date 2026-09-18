<script setup lang="ts">
import { nextTick, watch } from 'vue'
import { useConfirmStore } from '../stores/confirm'
import { useEscapeToClose } from '../composables/useEscapeToClose'
import { vFocus } from '../directives/focus'

/**
 * 全局确认弹窗（window.confirm 的应用内替代）。
 *
 * 原生的 confirm 跟界面完全两套画风，且在 Electron 里它还有焦点/模态的
 * 怪异行为。这里走 .overlay + .pop-surface 词汇表，与设置弹窗同一套材质。
 * Esc = 取消（fail closed，与 HostKeyDialog 的 Esc=拒绝 同一约定）；
 * Enter = 确定（焦点一开始就在确定钮上 —— v-focus，autofocus 对二次插入不可靠）。
 */
const store = useConfirmStore()

/**
 * 焦点进出成对：开时记住谁在焦点上，关时还回去（确定钮卸载会把焦点扔到
 * body，面板的快捷键就全哑了 —— 删除确认完再按快捷键没反应就是这么来的）。
 */
let prevFocus: HTMLElement | null = null
watch(
  () => store.visible,
  async (v) => {
    if (v) {
      prevFocus = document.activeElement as HTMLElement | null
      return
    }
    const el = prevFocus
    prevFocus = null
    await nextTick()
    if (el && document.contains(el)) el.focus()
  }
)

useEscapeToClose(
  () => store.visible,
  () => store.answer(false)
)

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter') return
  // 焦点在某个按钮上时不抢：按钮自己的 click 才是用户选的那个答案
  // （Tab 到「取消」按 Enter 被判成「确定」，删除类操作就危险了）
  if (e.target instanceof HTMLButtonElement) return
  e.stopPropagation()
  store.answer(true)
}
</script>

<template>
  <Transition name="pop">
    <div v-if="store.visible" class="overlay" @click.self="store.answer(false)">
      <div
        class="dialog pop-surface confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        :aria-label="store.message"
        @keydown="onKeydown"
      >
        <p class="confirm-msg">{{ store.message }}</p>
        <div class="confirm-actions">
          <button class="btn" @click="store.answer(false)">取消</button>
          <button
            class="btn"
            :class="{ danger: store.danger, primary: !store.danger }"
            v-focus
            @click="store.answer(true)"
          >{{ store.confirmText }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 基础长相在 styles.css（.overlay/.dialog/.pop-surface/.btn），这里只留差异 */
.confirm-dialog {
  width: 320px;
  padding: var(--sp-4);
}
.confirm-msg {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--fg);
  line-height: var(--lh-base);
  word-break: break-all;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
</style>

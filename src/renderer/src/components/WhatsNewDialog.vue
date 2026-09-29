<script setup lang="ts">
import { useWhatsNewStore } from '../stores/whatsnew'
import { useEscapeToClose } from '../composables/useEscapeToClose'

/**
 * 更新公告弹窗（每次更新后第一次打开时弹出）。
 *
 * 样式走 .overlay + .pop-surface 词汇表，与 ConfirmDialog 同一套材质；
 * Esc / 点背板 / 「知道了」都等于已读（announcement 没有「拒绝」这一支）。
 */
const store = useWhatsNewStore()

useEscapeToClose(
  () => store.payload !== null,
  () => store.dismiss()
)
</script>

<template>
  <Transition name="pop">
    <div v-if="store.payload" class="overlay" @click.self="store.dismiss()">
      <div class="dialog pop-surface whatsnew-dialog" role="dialog" aria-modal="true">
        <div class="dialog-header">
          <span>Dox v{{ store.payload.version }} 更新内容</span>
          <button class="close-btn" @click="store.dismiss()">×</button>
        </div>
        <ul class="notes">
          <li v-for="(note, i) in store.payload.notes" :key="i">{{ note }}</li>
        </ul>
        <div class="actions">
          <button class="btn primary" @click="store.dismiss()">知道了</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 基础长相在 styles.css（.overlay/.dialog/.pop-surface/.btn/.close-btn），这里只留差异 */
.whatsnew-dialog {
  width: 420px;
}
.notes {
  margin: 0;
  padding-left: var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--fg);
  line-height: var(--lh-base);
}
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--sp-4);
}
</style>

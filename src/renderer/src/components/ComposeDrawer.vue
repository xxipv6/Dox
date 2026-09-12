<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useComposeStore } from '../stores/compose'
import Icon from './Icon.vue'

/**
 * compose 输出抽屉（底部停靠，与传输队列同一位姿）。
 *
 * compose 是最容易炸的命令（拉镜像超时/端口占用/yaml 语法错），所以输出
 * 必须**边跑边滚**给人看，不对就随时「取消」（≈ Ctrl+C）改完再来。
 * 多条运行用 pill 切换，默认跟最新一条。
 */
const store = useComposeStore()

/** 当前看的运行：默认最新，用户点 pill 后跟随选择 */
const activeId = ref<string | null>(null)
const active = computed(
  () => store.runs.find((r) => r.id === activeId.value) ?? store.runs[store.runs.length - 1] ?? null
)
// 新运行出现时自动切过去（刚从菜单点出来的那条就是用户想看的）
watch(
  () => store.runs.length,
  (n) => {
    if (n) activeId.value = store.runs[n - 1].id
  }
)

const outEl = ref<HTMLElement | null>(null)
/** 用户往上翻就不拽回底部；回到底部附近才恢复跟随 */
let pinned = true

function onScroll(): void {
  const el = outEl.value
  if (!el) return
  pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch(
  () => active.value?.text,
  async () => {
    await nextTick()
    const el = outEl.value
    if (el && pinned) el.scrollTop = el.scrollHeight
  }
)
// 切运行时也滚到底
watch(activeId, async () => {
  pinned = true
  await nextTick()
  const el = outEl.value
  if (el) el.scrollTop = el.scrollHeight
})

const VERB_LABEL: Record<string, string> = { up: 'up -d', restart: 'restart', down: 'down' }

function statusIcon(status: string): { name: 'check' | 'alert' | 'x' | null; cls: string } {
  if (status === 'ok') return { name: 'check', cls: 'ok' }
  if (status === 'err') return { name: 'alert', cls: 'err' }
  if (status === 'canceled') return { name: 'x', cls: 'canceled' }
  return { name: null, cls: 'running' }
}
</script>

<template>
  <div v-if="store.visible && store.runs.length" class="compose-drawer">
    <div class="cd-head">
      <span class="cd-title">Compose</span>
      <span class="cd-runs">
        <button
          v-for="r in store.runs"
          :key="r.id"
          class="cd-pill"
          :class="[{ active: active?.id === r.id }, statusIcon(r.status).cls]"
          :title="`${r.file} · ${VERB_LABEL[r.verb]}`"
          @click="activeId = r.id"
        >
          <span v-if="r.status === 'running'" class="cd-spin"></span>
          <Icon v-else :name="statusIcon(r.status).name!" :size="11" />
          {{ VERB_LABEL[r.verb] }} · {{ r.file }}
        </button>
      </span>
      <span class="cd-actions">
        <button
          v-if="active?.status === 'running'"
          class="cd-btn danger"
          title="中断这次运行（≈ Ctrl+C，远端命令收 HUP 退出）"
          @click="store.cancel(active.id)"
        >
          取消
        </button>
        <button class="cd-btn" title="清掉已结束的记录" @click="store.clearDone()">清空</button>
        <button class="cd-btn" title="收起" @click="store.visible = false">
          <Icon name="x" :size="13" />
        </button>
      </span>
    </div>
    <pre ref="outEl" class="cd-out" @scroll="onScroll">{{ active?.text || '（等待输出…）' }}</pre>
    <div v-if="active && active.status !== 'running'" class="cd-foot" :class="active.status">
      <template v-if="active.status === 'ok'">完成（退出码 0）</template>
      <template v-else-if="active.status === 'canceled'">已取消</template>
      <template v-else>失败了（退出码非 0）—— 改完配置可以再跑一次</template>
    </div>
  </div>
</template>

<style scoped>
.compose-drawer {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  max-height: 220px;
}
.cd-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 4px var(--sp-3);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-xs);
}
.cd-title {
  font-weight: var(--fw-semibold);
  color: var(--fg-secondary);
  flex-shrink: 0;
}
.cd-runs {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
}
.cd-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: none;
  color: var(--fg-muted);
  font-size: var(--fs-xs);
  padding: 1px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.cd-pill.active {
  border-color: var(--accent-text);
  color: var(--fg);
}
.cd-pill.ok {
  color: var(--success-text);
}
.cd-pill.err {
  color: var(--danger-text);
}
.cd-pill.canceled {
  color: var(--warning-text);
}
.cd-spin {
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--accent-text);
  border-top-color: transparent;
  border-radius: 50%;
  animation: cd-rotate 0.8s linear infinite;
}
@keyframes cd-rotate {
  to {
    transform: rotate(360deg);
  }
}
.cd-actions {
  display: inline-flex;
  gap: 4px;
  flex-shrink: 0;
}
.cd-btn {
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  background: none;
  color: var(--fg-muted);
  font-size: var(--fs-xs);
  padding: 2px 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.cd-btn:hover {
  color: var(--fg);
  border-color: var(--fg-muted);
}
.cd-btn.danger {
  color: var(--danger-text);
  border-color: var(--danger-text);
}
.cd-out {
  flex: 1;
  min-height: 90px;
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  overflow-y: auto;
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--fg-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
.cd-foot {
  padding: 3px var(--sp-3);
  border-top: 1px solid var(--border);
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.cd-foot.ok {
  color: var(--success-text);
}
.cd-foot.err {
  color: var(--danger-text);
}
.cd-foot.canceled {
  color: var(--warning-text);
}
</style>

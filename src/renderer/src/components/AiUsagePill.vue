<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AiUsageResult, AiUsageSnapshot } from '@shared/types'
import { useSettingsStore } from '../stores/settings'
import Icon from './Icon.vue'

/**
 * 标题栏的 AI 容量速览（Kimi Code / DeepSeek / GLM）。
 *
 * 主进程每 5 分钟查一轮（AiUsageService），这里只读快照：账号为 0 时整条
 * 不渲染 —— 没配账号的用户不该被无关 UI 打扰。点开是各账号的明细浮层。
 *
 * 显示口径：Kimi/GLM 看 5 小时滚动窗（最紧的那道闸），DeepSeek 看余额。
 */
const api = window.api
const settings = useSettingsStore()

const snapshot = ref<AiUsageSnapshot | null>(null)
const open = ref(false)
const refreshing = ref(false)
/** 手动刷新失败的一句话（显示在浮层底部；下次成功自动清掉） */
const refreshError = ref('')

let off: (() => void) | null = null

onMounted(async () => {
  snapshot.value = await api.aiUsageGet().catch(() => null)
  off = api.onAiUsageUpdate((s) => {
    snapshot.value = s
    refreshing.value = false
  })
})

onUnmounted(() => off?.())

const accounts = computed(() => snapshot.value?.accounts ?? [])

/**
 * 头部紧凑显示：**已用**百分比（5h 窗 + 每周窗），DeepSeek 显示余额。
 * 用「已用」而不是「剩余」：报警语义顺（数字越大越危险），
 * 也和平台后台自己的展示口径一致。
 */
function headText(a: AiUsageResult): string {
  if (!a.ok) return '⚠'
  if (a.provider === 'deepseek') {
    return a.totalBalance !== undefined ? `${a.currency ?? '¥'}${a.totalBalance.toFixed(1)}` : '—'
  }
  const parts: string[] = []
  if (a.fiveHourUsed !== undefined) parts.push(`5h:${Math.round(a.fiveHourUsed)}%`)
  if (a.weeklyUsed !== undefined) parts.push(`7d:${Math.round(a.weeklyUsed)}%`)
  return parts.length ? parts.join(' ') : '—'
}

/** 用量档位：驱动颜色（已用 ≥70% 警示，≥90% 危险） */
function level(a: AiUsageResult): 'ok' | 'warn' | 'danger' | 'err' {
  if (!a.ok) return 'err'
  const used = a.provider === 'deepseek' ? null : (a.fiveHourUsed ?? a.weeklyUsed ?? null)
  if (used === null) return 'ok'
  if (used >= 90) return 'danger'
  if (used >= 70) return 'warn'
  return 'ok'
}

const PROVIDER_LABEL: Record<string, string> = { kimi: 'Kimi', deepseek: 'DeepSeek', glm: 'GLM' }

function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function refresh(): Promise<void> {
  refreshing.value = true
  try {
    snapshot.value = await api.aiUsageRefresh()
    refreshError.value = ''
  } catch (err) {
    // 主进程 handler 异常：不能静默吞成「转了一圈什么都没发生」
    refreshError.value = err instanceof Error ? err.message : String(err)
  } finally {
    refreshing.value = false
  }
}

function openSettings(): void {
  open.value = false
  settings.dialogVisible = true
}
</script>

<template>
  <span v-if="accounts.length" class="ai-usage">
    <button
      class="ai-pill"
      :class="{ open }"
      title="AI 容量（点击看明细）"
      @click.stop="open = !open"
    >
      <span
        v-for="a in accounts"
        :key="a.id"
        class="ai-acc"
        :class="level(a)"
        :title="`${a.name}（${PROVIDER_LABEL[a.provider] ?? a.provider}）`"
      >{{ a.name }} {{ headText(a) }}</span>
    </button>

    <!-- 明细浮层：点击其他区域关闭 -->
    <div v-if="open" class="ai-backdrop" @click="open = false"></div>
    <div v-if="open" class="ai-pop">
      <div class="ai-pop-head">
        <span>AI 容量</span>
        <span class="ai-pop-actions">
          <button class="ai-icon-btn" :class="{ spin: refreshing }" title="刷新" @click="refresh">
            <Icon name="refresh" :size="13" />
          </button>
          <button class="ai-icon-btn" title="管理账号" @click="openSettings">
            <Icon name="settings" :size="13" />
          </button>
        </span>
      </div>

      <div v-for="a in accounts" :key="a.id" class="ai-card">
        <div class="ai-card-head">
          <span class="ai-name">{{ a.name }}</span>
          <span class="ai-provider">{{ PROVIDER_LABEL[a.provider] ?? a.provider }}<template v-if="a.membership"> · {{ a.membership }}</template></span>
        </div>
        <div v-if="!a.ok" class="ai-err">{{ a.error }}</div>
        <template v-else>
          <div v-if="a.fiveHourUsed !== undefined" class="ai-bar-row">
            <span class="ai-bar-label">5 小时窗</span>
            <span class="ai-bar">
              <span
                class="ai-bar-fill"
                :class="level(a)"
                :style="{ width: `${Math.min(100, a.fiveHourUsed)}%` }"
              ></span>
            </span>
            <span class="ai-bar-val">{{ Math.round(a.fiveHourUsed) }}%</span>
          </div>
          <div v-if="a.weeklyUsed !== undefined" class="ai-bar-row">
            <span class="ai-bar-label">每周</span>
            <span class="ai-bar">
              <span
                class="ai-bar-fill"
                :class="(a.weeklyUsed ?? 0) >= 90 ? 'danger' : (a.weeklyUsed ?? 0) >= 70 ? 'warn' : 'ok'"
                :style="{ width: `${Math.min(100, a.weeklyUsed)}%` }"
              ></span>
            </span>
            <span class="ai-bar-val">{{ Math.round(a.weeklyUsed) }}%</span>
          </div>
          <div v-if="a.totalBalance !== undefined" class="ai-line">
            余额 {{ a.currency ?? '' }}{{ a.totalBalance.toFixed(2) }}
            <template v-if="a.grantedBalance">（含赠送 {{ a.grantedBalance.toFixed(2) }}）</template>
          </div>
          <div v-if="a.mcpRemaining !== undefined" class="ai-line">MCP 本月剩余 {{ a.mcpRemaining }} 次</div>
          <div class="ai-line dim">
            <template v-if="a.fiveHourReset">5h 窗 {{ fmtTime(a.fiveHourReset) }} 重置</template>
            <template v-if="a.weeklyReset"> · 每周 {{ fmtTime(a.weeklyReset) }} 重置</template>
          </div>
        </template>
      </div>

      <div v-if="refreshError" class="ai-foot" style="color: var(--danger-text)">{{ refreshError }}</div>
      <div v-else-if="snapshot" class="ai-foot">
        更新于 {{ fmtTime(snapshot.fetchedAt) }} · 每 5 分钟自动刷新
      </div>
    </div>
  </span>
</template>

<style scoped>
.ai-usage {
  position: relative;
  display: inline-flex;
  align-items: center;
  -webkit-app-region: no-drag;
}
.ai-pill {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: none;
  padding: 2px 8px;
  cursor: pointer;
  font-size: var(--fs-xs);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.ai-pill:hover,
.ai-pill.open {
  border-color: var(--accent-text);
}
.ai-acc {
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ai-acc.warn {
  color: var(--warning-text);
}
.ai-acc.danger,
.ai-acc.err {
  color: var(--danger-text);
}

.ai-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
}
.ai-pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 91;
  width: 280px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--sp-3);
}
.ai-pop-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--fg);
  margin-bottom: var(--sp-2);
}
.ai-pop-actions {
  display: inline-flex;
  gap: 2px;
}
.ai-icon-btn {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 3px;
  border-radius: var(--r-xs);
  display: inline-flex;
}
.ai-icon-btn:hover {
  color: var(--fg);
  background: var(--bg-hover);
}
.ai-icon-btn.spin {
  animation: ai-spin 0.9s linear infinite;
}
@keyframes ai-spin {
  to {
    transform: rotate(360deg);
  }
}

.ai-card {
  border-top: 1px solid var(--border);
  padding: var(--sp-2) 0;
}
.ai-card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 4px;
}
.ai-name {
  font-size: var(--fs-sm);
  color: var(--fg);
  font-weight: var(--fw-medium);
}
.ai-provider {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.ai-err {
  font-size: var(--fs-xs);
  color: var(--danger-text);
  line-height: 1.5;
}
.ai-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0;
}
.ai-bar-label {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  width: 46px;
  flex-shrink: 0;
}
.ai-bar {
  flex: 1;
  height: 5px;
  border-radius: var(--r-pill);
  background: var(--bg-active);
  overflow: hidden;
}
.ai-bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--success-text);
  transition: width var(--dur-slow) var(--ease-out);
}
.ai-bar-fill.warn {
  background: var(--warning-text);
}
.ai-bar-fill.danger {
  background: var(--danger-text);
}
.ai-bar-val {
  font-size: var(--fs-xs);
  color: var(--fg-secondary);
  width: 34px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ai-line {
  font-size: var(--fs-xs);
  color: var(--fg-secondary);
  line-height: 1.7;
}
.ai-line.dim {
  color: var(--fg-muted);
}
.ai-foot {
  border-top: 1px solid var(--border);
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { colLabel, maxCols } from '../utils/csv'

/**
 * CSV/TSV 的只读表格视图（Numbers 风格：行号列 + A/B/C 列标 + 网格线）。
 *
 * 纯展示：解析归 FileEditor 的 computed（状态栏的 N 行 × M 列 要共用同一份结果），
 * 这里只接收现成的 rows。单元格右对齐只认纯数字（千分位不认 —— 逗号分隔的
 * csv 里千分位必然被引号包着，识别收益低误判高）。
 */

const props = defineProps<{ rows: string[][] }>()

/**
 * 渲染行数上限：2MB 的 csv 可能几万行，全量建 DOM（行×列的 td）首次布局会到秒级。
 * 2000 行约 40 屏，足够「看一眼」；剩下的交给文本模式，尾注指路。
 * 解析仍是全量的（总行数/最大列数来自解析结果）。
 */
const RENDER_ROW_CAP = 2000
/** 列同理：一行几千个分隔符的「csv」（科研导出/改名的文本）会把一次 patch 顶到百万级 td */
const RENDER_COL_CAP = 100

const rendered = computed(() => props.rows.slice(0, RENDER_ROW_CAP))
const truncated = computed(() => props.rows.length > RENDER_ROW_CAP)
const colCount = computed(() => maxCols(props.rows))
const renderedCols = computed(() => Math.min(colCount.value, RENDER_COL_CAP))
const colsTruncated = computed(() => colCount.value > RENDER_COL_CAP)

/** 纯数字单元格：可选符号 / 小数 / 科学计数 */
const NUM_RE = /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

/** 整格都是 http(s) URL 才算链接格（锚定两端、无空白/封口符）。主进程 openExternal
 *  只放行 http/https，正好同口径；与编辑器里的 URL（FileEditor 的 UrlHover）同一套交互。 */
const CELL_URL_RE = /^https?:\/\/[^\s<>"'`)\],;]+$/
const isUrl = (v: string): boolean => CELL_URL_RE.test(v)

/** Cmd/Ctrl 按住：链接格显形（下划线 + 手型）→ 点击打开。挂 window：鼠标可能在表格外松开 */
const modHeld = ref(false)
const onKey = (e: KeyboardEvent): void => {
  modHeld.value = e.metaKey || e.ctrlKey
}
/** 窗口失焦收不到 keyup，修饰键会卡在「按住」：复位 */
const onWinBlur = (): void => {
  modHeld.value = false
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  window.addEventListener('blur', onWinBlur)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKey)
  window.removeEventListener('blur', onWinBlur)
})

/** 事件委托：整个表一个 mousedown（逐格绑事件在 2000 行上不值得），命中链接格才消费 */
function onMousedown(e: MouseEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return
  const td = (e.target as HTMLElement).closest('td.cell.url')
  if (!td) return
  e.preventDefault()
  void window.api.openExternal(td.textContent ?? '')
}

/** title 里把换行换成可见符号，否则多行字段的 tooltip 挤成一行 */
function tip(v: string): string {
  return v.replace(/\r?\n/g, '⏎')
}
</script>

<template>
  <div class="csv-host" :class="{ 'mod-held': modHeld }" @mousedown="onMousedown">
    <table class="csv-table">
      <thead>
        <tr>
          <th class="corner"></th>
          <th v-for="c in renderedCols" :key="c" class="col-head">{{ colLabel(c - 1) }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, r) in rendered" :key="r">
          <td class="row-num">{{ r + 1 }}</td>
          <td
            v-for="c in renderedCols"
            :key="c"
            class="cell"
            :class="{ num: NUM_RE.test(row[c - 1] ?? ''), url: isUrl(row[c - 1] ?? '') }"
            :title="tip(row[c - 1] ?? '')"
          >{{ row[c - 1] ?? '' }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="truncated || colsTruncated" class="csv-note">
      <template v-if="truncated">已显示前 {{ RENDER_ROW_CAP }} 行（共 {{ rows.length }} 行）</template>
      <template v-if="truncated && colsTruncated"> · </template>
      <template v-if="colsTruncated">已显示前 {{ RENDER_COL_CAP }} 列（共 {{ colCount }} 列）</template>
      · 切换到文本模式查看全部
    </div>
  </div>
</template>

<style scoped>
/* 配色全走编辑器令牌（--ed-*）：表格是代码区的另一种呈现，跟界面色相走会串味 */
.csv-host {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--ed-bg);
  color: var(--ed-fg);
  font-size: var(--fs-sm);
}
.csv-table {
  border-collapse: collapse;
  white-space: nowrap;
}
th,
td {
  border: 1px solid color-mix(in srgb, var(--ed-fg) 15%, transparent);
  padding: 3px 8px;
  text-align: left;
}
/* sticky 的三件套都必须有实底色，否则滚动时内容从底下透出来 */
.corner,
.col-head,
.row-num {
  position: sticky;
  background: var(--ed-activeline);
  color: var(--ed-linenumber);
  font-family: var(--font-mono);
  font-weight: var(--fw-normal);
  z-index: 1; /* 表头/行号列盖住滚动经过的数据 */
}
.col-head {
  top: 0;
}
.row-num {
  left: 0;
  text-align: right;
}
.corner {
  top: 0;
  left: 0;
  z-index: 2; /* 角格永远在最上（斜向滚动时表头和行号列都从它底下过） */
}
/* 超长字段不能把整表撑爆：截断 + title 看全量 */
.cell {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* Cmd/Ctrl 按住时链接格才显形（下划线 + 手型），与编辑器 URL 悬停同一套手感 */
.mod-held .cell.url {
  text-decoration: underline;
  cursor: pointer;
}
.csv-note {
  padding: 6px 10px;
  font-size: var(--fs-xs);
  color: var(--ed-linenumber);
  white-space: nowrap;
}
</style>

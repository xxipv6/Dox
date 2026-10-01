/**
 * FileEditor 的按文件 EditorState 缓存（撤销历史 / 光标 / 选区随它存活），
 * 外加 CSV 视图偏好。
 *
 * 为什么住在模块级而不是 FileEditor 组件里：App.vue 按 `ed-<sessionId>` 作 key，
 * 切标签会销毁重建 FileEditor，组件内的 Map 随之蒸发 —— dirty 内容在 editor
 * store 里保得住，撤销历史却没了，切回来后 ⌘Z 变死键（光标也跳回开头）。
 *
 * key 带 sessionId（不同标签可能开着同路径的文件，比如宿主与容器里的 /etc/hosts）。
 * 生命周期对齐打开的文件：关文件标签清条目（FileEditor 的 files watch 调
 * pruneSession），会话断开整组清（editor store 的 dropSession）。
 */
import type { EditorState } from '@codemirror/state'
import { reactive } from 'vue'

const states = new Map<string, EditorState>()
/** CSV/TSV 的「表格/文本」视图偏好（true = 表格；缺省按表格）。模块级 reactive，跨重挂载存活 */
const csvPrefs = reactive<Record<string, boolean>>({})

const keyOf = (sessionId: string, path: string): string => `${sessionId}\n${path}`

export function getEditorState(sessionId: string, path: string): EditorState | undefined {
  return states.get(keyOf(sessionId, path))
}

export function setEditorState(sessionId: string, path: string, state: EditorState): void {
  states.set(keyOf(sessionId, path), state)
}

export function deleteEditorState(sessionId: string, path: string): void {
  states.delete(keyOf(sessionId, path))
}

export function csvTablePref(sessionId: string, path: string): boolean | undefined {
  return csvPrefs[keyOf(sessionId, path)]
}

export function setCsvTablePref(sessionId: string, path: string, on: boolean): void {
  csvPrefs[keyOf(sessionId, path)] = on
}

/** 文件标签关闭后清掉对应条目（重新打开要看到新内容，不能复活旧 state） */
export function pruneSessionStates(sessionId: string, alivePaths: ReadonlySet<string>): void {
  const prefix = `${sessionId}\n`
  for (const key of states.keys()) {
    if (key.startsWith(prefix) && !alivePaths.has(key.slice(prefix.length))) states.delete(key)
  }
  for (const key of Object.keys(csvPrefs)) {
    if (key.startsWith(prefix) && !alivePaths.has(key.slice(prefix.length))) delete csvPrefs[key]
  }
}

/** 会话断开/清理时整组丢弃 */
export function dropSessionStates(sessionId: string): void {
  const prefix = `${sessionId}\n`
  for (const key of states.keys()) {
    if (key.startsWith(prefix)) states.delete(key)
  }
  for (const key of Object.keys(csvPrefs)) {
    if (key.startsWith(prefix)) delete csvPrefs[key]
  }
}

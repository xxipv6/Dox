import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { RemoteFileContent } from '@shared/types'
import { errorText } from '../utils/errors'

export interface OpenFile {
  /** 远端绝对路径，同时作为唯一标识 */
  path: string
  /** 会话 id：会话断开时这份文件就没意义了 */
  sessionId: string
  name: string
  /** 编辑器中的当前内容 */
  content: string
  /** 打开 / 上次保存时的内容，用于判断是否有未保存改动 */
  savedContent: string
  /** 打开 / 上次保存时的远端 mtime，保存时回传做冲突检测 */
  mtime: number
  loading: boolean
  saving: boolean
  error: string
}

/** 每个会话各自维护一份打开列表：切会话不该看到别人打开的文件 */
const filesBySession = reactive<Record<string, OpenFile[]>>({})
const activePathBySession = reactive<Record<string, string>>({})

export const useEditorStore = defineStore('editor', () => {
  /** 编辑器面板是否展开 */
  const visible = ref(false)
  /**
   * 有未保存改动的文件数。关闭面板 / 关闭标签前据此拦截 ——
   * 编辑器里是一屏没保存的配置改动，静默丢掉等于白干。
   */
  const dirtyCount = computed(() =>
    Object.values(filesBySession)
      .flat()
      .filter((f) => f.content !== f.savedContent).length
  )

  function filesOf(sessionId: string | null): OpenFile[] {
    return sessionId ? (filesBySession[sessionId] ?? []) : []
  }

  function activeFile(sessionId: string | null): OpenFile | null {
    if (!sessionId) return null
    const path = activePathBySession[sessionId]
    return filesOf(sessionId).find((f) => f.path === path) ?? null
  }

  function isDirty(file: OpenFile): boolean {
    return file.content !== file.savedContent
  }

  function hasDirty(sessionId: string): boolean {
    return filesOf(sessionId).some(isDirty)
  }

  /** 打开远端文件。已打开的直接切过去，不重复读 */
  async function open(sessionId: string, path: string): Promise<void> {
    const list = (filesBySession[sessionId] ??= [])
    const existing = list.find((f) => f.path === path)
    if (existing) {
      activePathBySession[sessionId] = path
      visible.value = true
      return
    }

    const name = path.split('/').pop() || path
    const file = reactive<OpenFile>({
      path,
      sessionId,
      name,
      content: '',
      savedContent: '',
      mtime: 0,
      loading: true,
      saving: false,
      error: ''
    })
    list.push(file)
    activePathBySession[sessionId] = path
    visible.value = true

    try {
      const res: RemoteFileContent = await window.api.sftpReadText(sessionId, path)
      if (res.binary) {
        // 二进制不进编辑器：留在列表里展示错误，用户自己关掉
        file.error = '这是二进制文件，无法以文本方式编辑。请使用「下载」后在本地打开。'
      } else {
        file.content = res.content
        file.savedContent = res.content
        file.mtime = res.mtime
      }
    } catch (err) {
      file.error = errorText(err)
    } finally {
      file.loading = false
    }
  }

  /**
   * 丢弃本地修改，重新从远端读取。
   * 不能复用 open()：它发现文件已在列表中就直接切过去，不会真的重读。
   */
  async function reload(sessionId: string, path: string): Promise<void> {
    const file = filesOf(sessionId).find((f) => f.path === path)
    if (!file) return
    if (isDirty(file) && !confirm(`「${file.name}」有未保存的修改，重新加载将丢弃它们，确定？`)) return

    file.loading = true
    file.error = ''
    try {
      const res = await window.api.sftpReadText(sessionId, path)
      if (res.binary) {
        file.error = '这是二进制文件，无法以文本方式编辑。请使用「下载」后在本地打开。'
      } else {
        file.content = res.content
        file.savedContent = res.content
        file.mtime = res.mtime
      }
    } catch (err) {
      file.error = errorText(err)
    } finally {
      file.loading = false
    }
  }

  /** 保存回远端。返回是否成功 */
  async function save(sessionId: string, path: string): Promise<boolean> {
    const file = filesOf(sessionId).find((f) => f.path === path)
    if (!file || file.saving) return false

    file.saving = true
    file.error = ''
    try {
      file.mtime = await window.api.sftpWriteText(sessionId, path, file.content, file.mtime)
      file.savedContent = file.content
      return true
    } catch (err) {
      file.error = errorText(err)
      return false
    } finally {
      file.saving = false
    }
  }

  /**
   * 关闭一个文件标签。
   * 有未保存改动时先问一句 —— 这些内容只存在于内存里，关掉就没了。
   */
  function close(sessionId: string, path: string): void {
    const list = filesOf(sessionId)
    const file = list.find((f) => f.path === path)
    if (!file) return
    if (isDirty(file) && !confirm(`「${file.name}」有未保存的修改，确定丢弃？`)) return

    const idx = list.indexOf(file)
    list.splice(idx, 1)

    if (activePathBySession[sessionId] === path) {
      // 关掉当前标签后落到右邻，没有则左邻（编辑器里的常见行为）
      const next = list[idx] ?? list[idx - 1]
      if (next) activePathBySession[sessionId] = next.path
      else delete activePathBySession[sessionId]
    }
    if (list.length === 0) delete filesBySession[sessionId]
  }

  function setActive(sessionId: string, path: string): void {
    activePathBySession[sessionId] = path
  }

  /** 整个编辑器面板收起（有未保存改动时拦截） */
  function hide(sessionId: string): void {
    if (hasDirty(sessionId) && !confirm('有未保存的修改，收起面板将丢弃它们，确定继续？')) return
    visible.value = false
  }

  /** 会话断开 / SFTP 关闭时清理，避免状态无限堆积 */
  function dropSession(sessionId: string): void {
    delete filesBySession[sessionId]
    delete activePathBySession[sessionId]
  }

  /**
   * 会话断开：有未保存改动的文件留在编辑器里（那是用户唯一的副本，
   * 不能替他丢掉），只标记成不可保存；没有改动的文件随会话一起清掉，
   * 否则连过几十台主机后这些状态会一直堆着。
   */
  function onSessionClosed(sessionId: string): void {
    const list = filesOf(sessionId)
    if (list.length === 0) return

    const kept = list.filter((f) => {
      if (isDirty(f)) {
        f.error = '会话已断开，无法保存回远端。请自行复制内容留存。'
        return true
      }
      return false
    })

    if (kept.length === 0) {
      dropSession(sessionId)
    } else {
      filesBySession[sessionId] = kept
      activePathBySession[sessionId] = kept[0].path
    }
  }

  // 会话掉线时自动收尾，不用每个调用点自己记得通知
  window.api.onStatus(({ id, status }) => {
    if (status === 'closed' || status === 'error') onSessionClosed(id)
  })

  return {
    visible,
    dirtyCount,
    filesOf,
    activeFile,
    isDirty,
    hasDirty,
    open,
    reload,
    save,
    close,
    setActive,
    hide,
    dropSession,
    onSessionClosed
  }
})

import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { RemoteFileContent } from '@shared/types'
import { errorText } from '../utils/errors'

export interface OpenFile {
  /** 远端绝对路径，同时作为唯一标识 */
  path: string
  /** 会话 id：会话断开时这份文件就没意义了（容器文件记容器标签的 pane id） */
  sessionId: string
  /** 实际的文件操作目标：宿主机会话 id + 容器名（宿主机文件为 undefined） */
  fsSessionId?: string
  containerName?: string
  name: string
  /** 编辑器中的当前内容 */
  content: string
  /** 打开 / 上次保存时的内容，用于判断是否有未保存改动 */
  savedContent: string
  /** 打开 / 上次保存时的远端 mtime，保存时回传做冲突检测 */
  mtime: number
  /** 远端文件字节数（读取时来自 res.size，保存后按写入内容重算）。状态栏非 dirty 态显示它 */
  size: number
  /** true = 预览标签（斜体）：同会话最多一个，会被下一个预览替换；编辑即转正 */
  preview: boolean
  loading: boolean
  saving: boolean
  error: string
  /**
   * true = 上次保存被 mtime 冲突拒绝（远端在编辑期间被别处改过）。
   * 界面据此给「强制覆盖 / 重新加载」而不是一句普通错误。
   */
  conflict: boolean
  /**
   * 打开后跳到指定行（搜索结果点击）。seq 单调递增是关键：
   * 同一行点两次也要能重新触发（行号相同 seq 不同）；
   * FileEditor 用 seq 比对防重放（切标签回来不旧跳）。
   */
  revealLine: { line: number; seq: number } | null
}

/** revealLine 的触发序号（模块级单调递增，跨文件唯一） */
let revealSeq = 0

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

  /**
   * 打开远端文件。已打开的直接切过去，不重复读。fs 给了就是容器文件（经 agent）。
   * opts.line = 打开后跳到该行；opts.preview = 预览标签（见 OpenFile.preview）。
   */
  async function open(
    sessionId: string,
    path: string,
    fs?: { sessionId: string; containerName: string },
    opts?: { line?: number; preview?: boolean }
  ): Promise<void> {
    const list = (filesBySession[sessionId] ??= [])
    const existing = list.find((f) => f.path === path)
    if (existing) {
      // 普通打开（双击等）已处于预览态的文件：原地转正（VS Code 语义）。
      // 这也是「树单击→双击三连」能成立的关键：第一次 click 已预览打开，
      // dblclick 到达时走这里转正，不重复读、不开第二个标签。
      if (!opts?.preview) existing.preview = false
      activePathBySession[sessionId] = path
      visible.value = true
      // 已打开是「同一文件点不同匹配行」的主路径：不能只切活跃就 return
      if (opts?.line) existing.revealLine = { line: opts.line, seq: ++revealSeq }
      return
    }

    // 反斜杠分隔只对本机会话认：远端 posix 文件名里反斜杠是合法字符，拆了会显示错名字
    const name = (sessionId.startsWith('local-') ? path.split(/[\\/]/).pop() : path.split('/').pop()) || path
    const file = reactive<OpenFile>({
      path,
      sessionId,
      fsSessionId: fs?.sessionId,
      containerName: fs?.containerName,
      name,
      content: '',
      savedContent: '',
      mtime: 0,
      size: 0,
      preview: !!opts?.preview,
      loading: true,
      saving: false,
      error: '',
      conflict: false,
      revealLine: opts?.line ? { line: opts.line, seq: ++revealSeq } : null
    })

    // 预览标签替换：同会话最多一个预览，新的顶掉旧的（原位 splice，标签不跳到队尾）。
    // 旧的如果是 dirty 的（编辑即转正后正常流程不会出现，纯防御分支）——转正保命，
    // 不弹 confirm：预览是快速浏览动作，中途弹窗打断比丢一个标签更糟。
    const pIdx = opts?.preview ? list.findIndex((f) => f.preview) : -1
    if (pIdx >= 0 && isDirty(list[pIdx])) {
      list[pIdx].preview = false
      list.push(file)
    } else if (pIdx >= 0) {
      list.splice(pIdx, 1, file)
    } else {
      list.push(file)
    }
    activePathBySession[sessionId] = path
    visible.value = true

    try {
      const res: RemoteFileContent = await window.api.sftpReadText(
        file.fsSessionId ?? sessionId,
        path,
        file.containerName
      )
      if (res.binary) {
        // 二进制不进编辑器：留在列表里展示错误，用户自己关掉
        file.error = '这是二进制文件，无法以文本方式编辑。请使用「下载」后在本地打开。'
      } else {
        file.content = res.content
        file.savedContent = res.content
        file.mtime = res.mtime
        file.size = res.size
      }
    } catch (err) {
      file.error = errorText(err)
    } finally {
      file.loading = false
    }
  }

  /** 预览标签转正：目前唯一触发点是用户开始编辑（FileEditor 的 updateListener） */
  function pinPreview(sessionId: string, path: string): void {
    const file = filesOf(sessionId).find((f) => f.path === path)
    if (file) file.preview = false
  }

  /**
   * 丢弃本地修改，重新从远端读取。
   * 不能复用 open()：它发现文件已在列表中就直接切过去，不会真的重读。
   * discard=true 跳过未保存确认（冲突横幅的「重新加载」——用户已经在横幅里做过选择了）。
   */
  async function reload(sessionId: string, path: string, opts?: { discard?: boolean }): Promise<void> {
    const file = filesOf(sessionId).find((f) => f.path === path)
    if (!file) return
    if (!opts?.discard && isDirty(file) && !confirm(`「${file.name}」有未保存的修改，重新加载将丢弃它们，确定？`)) return

    file.loading = true
    file.error = ''
    file.conflict = false
    try {
      const res = await window.api.sftpReadText(file.fsSessionId ?? sessionId, path, file.containerName)
      if (res.binary) {
        file.error = '这是二进制文件，无法以文本方式编辑。请使用「下载」后在本地打开。'
      } else {
        file.content = res.content
        file.savedContent = res.content
        file.mtime = res.mtime
        file.size = res.size
      }
    } catch (err) {
      file.error = errorText(err)
    } finally {
      file.loading = false
    }
  }

  /**
   * 保存回远端。返回是否成功。
   * force=true 不做 mtime 冲突检测（用户在冲突横幅里显式选了「强制覆盖」）。
   */
  async function save(sessionId: string, path: string, opts?: { force?: boolean }): Promise<boolean> {
    const file = filesOf(sessionId).find((f) => f.path === path)
    if (!file || file.saving) return false

    file.saving = true
    file.error = ''
    file.conflict = false
    try {
      file.mtime = await window.api.sftpWriteText(
        file.fsSessionId ?? sessionId,
        path,
        file.content,
        opts?.force ? undefined : file.mtime,
        file.containerName
      )
      file.savedContent = file.content
      // sftpWriteText 只返回 mtime；写入的内容就是 content，字节数自己算
      file.size = new TextEncoder().encode(file.content).length
      return true
    } catch (err) {
      const text = errorText(err)
      // 宿主机（已被外部修改）与容器 agent（已被他人修改）两种文案都认
      file.conflict = /已被.*修改/.test(text)
      file.error = text
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

  /** 整个编辑器面板收起（有未保存改动时提示一句 —— 只是提示，内容并不丢） */
  function hide(sessionId: string): void {
    if (hasDirty(sessionId) && !confirm('有未保存的修改（收起不会丢失，重新展开可继续编辑）。确定收起？')) return
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
    pinPreview,
    hide,
    dropSession,
    onSessionClosed
  }
})

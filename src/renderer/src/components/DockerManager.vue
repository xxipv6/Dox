<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  ContainerImage,
  ContainerInfo,
  ContainerProbeResult,
  ImageDfRow,
  SavedSession
} from '@shared/types'
import { useSessionStore } from '../stores/sessions'
import { useConfirmStore } from '../stores/confirm'
import { pushToast } from '../stores/toast'
import { errorText } from '../utils/errors'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import Icon from './Icon.vue'
import Spinner from './Spinner.vue'

/**
 * 容器管理抽屉（入口：侧栏设备右键「容器管理」）。
 *
 * 一台设备一个抽屉：容器页管生命周期（进/日志/启停/删），镜像页管
 * 列表/拉取/导出/删除/清理（1Panel 口径：悬空与未使用分开选）。
 * 所有命令都骑在这台设备的传输会话上（ensureTransport），不新开连接。
 */

const props = defineProps<{ saved: SavedSession }>()
const emit = defineEmits<{ close: [] }>()

const api = window.api
const store = useSessionStore()

/** 设备的传输会话 id（一切 docker 命令的承载） */
const tid = ref<string | null>(null)
const bootError = ref('')
const tab = ref<'containers' | 'images'>('containers')

// ---- 容器页 ----

const probe = ref<ContainerProbeResult | null>(null)
const listLoading = ref(false)
const controlling = ref<string | null>(null)
const ctrMenu = ref<{ x: number; y: number; box: ContainerInfo } | null>(null)

const containers = computed(() => (probe.value?.ok ? probe.value.list.containers : []))

async function refreshContainers(): Promise<void> {
  if (!tid.value) return
  listLoading.value = true
  try {
    probe.value = await api.listContainers(tid.value)
  } catch (err) {
    probe.value = { ok: false, reason: 'error', message: errorText(err) }
  } finally {
    listLoading.value = false
  }
}

const ctrMenuItems = computed<ContextMenuItem[]>(() => {
  const box = ctrMenu.value?.box
  if (!box) return []
  const busy = controlling.value === box.name
  if (box.state === 'running') {
    return [
      { id: 'enter', label: '进入', icon: 'terminal', disabled: busy },
      { id: 'logs', label: '查看日志', icon: 'file', disabled: busy },
      { id: 'stop', label: '停止', icon: 'square', disabled: busy }
    ]
  }
  if (box.state === 'paused') {
    return [
      { id: 'unpause', label: '恢复', icon: 'play', disabled: busy },
      { id: 'logs', label: '查看日志', icon: 'file', disabled: busy }
    ]
  }
  return [
    { id: 'start', label: '启动', icon: 'play', disabled: busy },
    { id: 'logs', label: '查看日志', icon: 'file', disabled: busy },
    { id: 'remove', label: '删除', icon: 'trash', danger: true, disabled: busy }
  ]
})

const CTR_CONFIRMS: Record<string, (name: string) => string> = {
  stop: (n) => `停止容器「${n}」？其中运行的服务会中断。`,
  remove: (n) => `删除容器「${n}」？此操作不可恢复（镜像与数据卷不受影响）。`
}

async function enterContainer(box: ContainerInfo): Promise<void> {
  await store.enterContainerDirect(props.saved, box)
  emit('close')
}

async function onCtrMenuSelect(id: string): Promise<void> {
  const box = ctrMenu.value?.box
  ctrMenu.value = null
  if (!box || !tid.value) return

  if (id === 'enter') {
    await enterContainer(box)
    return
  }
  if (id === 'logs') {
    try {
      await store.viewContainerLogs(tid.value, box, props.saved.id)
    } catch (err) {
      pushToast(`查看日志失败：${errorText(err)}`)
    }
    return
  }

  const ask = CTR_CONFIRMS[id]
  if (ask && !(await useConfirmStore().ask(ask(box.name)))) return
  controlling.value = box.name
  try {
    await api.controlContainer(tid.value, box.name, id as 'start' | 'stop' | 'unpause' | 'remove')
    await new Promise((r) => setTimeout(r, 600))
    await refreshContainers()
  } catch (err) {
    pushToast(`操作失败：${errorText(err)}`)
    await refreshContainers()
  } finally {
    controlling.value = null
  }
}

// ---- 镜像页 ----

const images = ref<ContainerImage[] | null>(null)
const imagesError = ref('')
const imagesLoading = ref(false)
/** 正在删除/导出的镜像 key（repo:tag 或 id），行内显「处理中…」 */
const imgBusy = ref<string | null>(null)

async function refreshImages(): Promise<void> {
  if (!tid.value) return
  imagesLoading.value = true
  try {
    const r = await api.containerImages(tid.value)
    if (r.ok) {
      images.value = r.images ?? []
      imagesError.value = ''
    } else {
      imagesError.value = r.message || '列出镜像失败'
    }
  } catch (err) {
    imagesError.value = errorText(err)
  } finally {
    imagesLoading.value = false
  }
}

/** docker 认的引用：有标签用 repo:tag，悬空镜像只能按 id */
function imageRef(img: ContainerImage): string {
  return img.tag !== '<none>' ? `${img.repository}:${img.tag}` : img.id
}

function imageLabel(img: ContainerImage): string {
  return `${img.repository}:${img.tag}`
}

// 拉取（输出走 containerImageEvent，docker 进度条用 \r 刷新，每段最后一行就是当前状态）
const pullRef = ref('')
const pulling = ref(false)
const pullLine = ref('')

async function pull(): Promise<void> {
  const ref = pullRef.value.trim()
  if (!ref || !tid.value || pulling.value) return
  pulling.value = true
  pullLine.value = '正在拉取…'
  try {
    const r = await api.containerImagePull(tid.value, ref)
    if (r.ok) {
      pushToast(`镜像 ${ref} 拉取完成`, 'success')
      pullRef.value = ''
      await refreshImages()
    } else if (!r.canceled) {
      pushToast(`拉取失败：${r.message || '未知错误'}`)
    }
  } finally {
    pulling.value = false
    pullLine.value = ''
  }
}

/** 取消拉取（主进程关通道 ≈ 远端 docker pull 收 HUP） */
function cancelPull(): void {
  if (tid.value) void api.containerImagePullCancel(tid.value)
}

// 删除：使用中的镜像不给删（按钮禁用），避免 docker 报错再绕一圈
async function removeImage(img: ContainerImage): Promise<void> {
  if (!tid.value || imgBusy.value) return
  if (!(await useConfirmStore().ask(`删除镜像「${imageLabel(img)}」？`))) return
  imgBusy.value = imageLabel(img)
  try {
    const r = await api.containerImageRemove(tid.value, [imageRef(img)], false)
    if (r.ok) {
      pushToast(`镜像 ${imageLabel(img)} 已删除`, 'success')
    } else {
      pushToast(`删除失败：${r.message || '未知错误'}`)
    }
    await refreshImages()
  } finally {
    imgBusy.value = null
  }
}

/*
 * 导出：远端先 docker save 到临时文件，再走既有下载通道（弹保存框、进传输队列）。
 * 临时文件必须等下载落定（done/error/canceled）后再删 —— 入队就删的话，
 * 队列还没读到文件它就没了。
 */
const exporting = ref<string | null>(null)

async function exportImage(img: ContainerImage): Promise<void> {
  if (!tid.value || exporting.value) return
  const ref = imageRef(img)
  exporting.value = imageLabel(img)
  let tmpPath: string | null = null
  try {
    const r = await api.containerImageSave(tid.value, ref)
    if (!r.ok || !r.tmpPath) {
      pushToast(`导出失败：${r.message || '未知错误'}`)
      return
    }
    tmpPath = r.tmpPath
    const fileName = `${img.repository.replace(/[\/:]/g, '_')}_${img.tag.replace(/[\/:]/g, '_')}.tar`
    const task = await api.download(tid.value, tmpPath, fileName)
    if (!task) return // 用户取消了保存框
    pushToast('导出任务已加入传输队列', 'success')
    await waitTransferSettled(task.id)
  } finally {
    exporting.value = null
    if (tmpPath) await api.sftpDelete(tid.value, tmpPath, false).catch(() => undefined)
  }
}

/** 等一条传输任务到终态（done/error/canceled）；队列事件驱动，不轮询 */
function waitTransferSettled(taskId: string): Promise<void> {
  return new Promise((resolve) => {
    const off = api.onTransferUpdate((tasks) => {
      const t = tasks.find((x) => x.id === taskId)
      if (t && (t.status === 'done' || t.status === 'error' || t.status === 'canceled')) {
        off()
        resolve()
      }
    })
    // 兜底：队列异常沉默也不能把临时文件留一辈子
    setTimeout(() => {
      off()
      resolve()
    }, 30 * 60_000)
  })
}

// ---- 清理（#4，1Panel 口径）----

const cleanVisible = ref(false)
const cleanLoading = ref(false)
const cleanRunning = ref(false)
const dfRows = ref<ImageDfRow[]>([])
/** 勾选：悬空 / 未使用（默认只勾悬空，未使用破坏性更大要显式选）/ 构建缓存 */
const cleanDangling = ref(true)
const cleanUnused = ref(false)
const cleanBuildCache = ref(false)

const danglingImages = computed(() => (images.value ?? []).filter((i) => i.repository === '<none>'))
const unusedImages = computed(() =>
  (images.value ?? []).filter((i) => i.repository !== '<none>' && !i.inUse)
)
/** df 里 Build Cache 那一行的可回收量（展示在选项旁，没有就不显示数字） */
const buildCacheReclaimable = computed(
  () => dfRows.value.find((r) => /build cache/i.test(r.type))?.reclaimable ?? ''
)

async function openCleanup(): Promise<void> {
  cleanVisible.value = true
  cleanDangling.value = true
  cleanUnused.value = false
  cleanBuildCache.value = false
  cleanLoading.value = true
  try {
    // df 与镜像列表一起拿：df 说「能回收多少」，列表数「各有几个候选」
    const [df] = await Promise.all([api.containerImageDf(tid.value!), refreshImages()])
    dfRows.value = df.ok ? (df.rows ?? []) : []
  } finally {
    cleanLoading.value = false
  }
}

async function runCleanup(): Promise<void> {
  if (!tid.value || cleanRunning.value) return
  if (!cleanDangling.value && !cleanUnused.value && !cleanBuildCache.value) return
  const parts: string[] = []
  if (cleanUnused.value) {
    parts.push(`${unusedImages.value.length} 个未使用镜像和 ${danglingImages.value.length} 个悬空镜像`)
  } else if (cleanDangling.value) {
    parts.push(`${danglingImages.value.length} 个悬空镜像`)
  }
  if (cleanBuildCache.value) parts.push('全部构建缓存')
  if (!(await useConfirmStore().ask(`清理 ${parts.join('、')}？此操作不可恢复。`))) return
  cleanRunning.value = true
  try {
    const tails: string[] = []
    // docker image prune -a 连悬空一起清，勾了「未使用」一条命令就够
    if (cleanUnused.value || cleanDangling.value) {
      const r = await api.containerImagePrune(tid.value, cleanUnused.value)
      if (!r.ok) {
        pushToast(`清理镜像失败：${r.message || '未知错误'}`)
        return
      }
      if (r.message) tails.push(r.message)
    }
    if (cleanBuildCache.value) {
      const r = await api.containerBuilderPrune(tid.value)
      if (!r.ok) {
        pushToast(`清理构建缓存失败：${r.message || '未知错误'}`)
        return
      }
      if (r.message) tails.push(r.message)
    }
    pushToast(tails.length ? `清理完成：${tails.join('；')}` : '清理完成', 'success')
    cleanVisible.value = false
    await refreshImages()
  } finally {
    cleanRunning.value = false
  }
}

// ---- 生命周期 ----

let offImageEvent: (() => void) | null = null

onMounted(async () => {
  offImageEvent = api.onContainerImageEvent((pid, ev) => {
    if (!tid.value || pid !== tid.value) return
    // 事件即「有活跃拉取」的事实来源：抽屉在拉取中途被关掉再打开时，
    // pulling 已经是 false，靠它把进度行重新点亮（主进程的拉取不随抽屉停）
    if (!pulling.value) pulling.value = true
    pullLine.value = ev.line
  })
  try {
    tid.value = await store.ensureTransport(props.saved.id)
  } catch (err) {
    bootError.value = errorText(err)
    return
  }
  void refreshContainers()
  void refreshImages()
})

onBeforeUnmount(() => {
  offImageEvent?.()
  // 进行中的拉取随抽屉关闭取消（进度界面都没了，别让远端白跑）；
  // 然后按空闲口径回收传输会话（侧栏没展开/无容器标签挂着就断开）
  if (pulling.value) cancelPull()
  store.releaseTransportIfIdle(props.saved.id)
})
</script>

<template>
  <div class="overlay dm-overlay" @click.self="emit('close')">
    <div class="dm-drawer pop-surface">
      <div class="dm-head">
        <span class="dm-title">
          <Icon name="box" :size="15" />
          容器管理 · {{ saved.name }}
        </span>
        <span class="dm-tabs">
          <button
            class="dm-tab"
            :class="{ on: tab === 'containers' }"
            type="button"
            @click="tab = 'containers'"
          >
            容器
          </button>
          <button
            class="dm-tab"
            :class="{ on: tab === 'images' }"
            type="button"
            @click="tab = 'images'"
          >
            镜像
          </button>
        </span>
        <button class="icon-btn" title="关闭" @click="emit('close')">
          <Icon name="x" :size="14" />
        </button>
      </div>

      <div v-if="bootError" class="empty-hint error">
        连接设备失败：{{ bootError }}
      </div>

      <!-- ============ 容器页 ============ -->
      <template v-else-if="tab === 'containers'">
        <div class="dm-toolbar">
          <span class="dm-hint">右键容器行出操作菜单</span>
          <button
            class="icon-btn"
            :class="{ dim: listLoading }"
            title="刷新容器列表"
            @click="refreshContainers"
          >
            <Icon name="refresh" :size="14" />
          </button>
        </div>
        <div v-if="listLoading && !containers.length" class="empty-hint">
          <Spinner text="正在列出容器…" />
        </div>
        <div v-else-if="probe && !probe.ok && probe.reason === 'no-binary'" class="empty-hint">
          {{ probe.message }}
        </div>
        <div v-else-if="probe && !probe.ok" class="empty-hint error">
          {{ probe.message }}
          <button class="retry" @click="refreshContainers">重试</button>
        </div>
        <div v-else-if="!containers.length" class="empty-hint">这台设备上没有运行中的容器</div>
        <div v-else class="dm-list" :class="{ dim: listLoading }">
          <div
            v-for="box in containers"
            :key="box.id"
            class="dm-row"
            :title="`${box.name}\n${box.image}\n${box.status}\n单击进入 · 右键更多操作`"
            @click="box.state === 'running' && enterContainer(box)"
            @contextmenu.prevent="ctrMenu = { x: $event.clientX, y: $event.clientY, box }"
          >
            <span class="dot" :class="[box.state, box.health]"></span>
            <span class="dm-row-main">
              <span class="dm-row-name">{{ box.name }}</span>
              <span class="dm-row-sub">{{ box.image }} · {{ box.status }}</span>
            </span>
            <span v-if="controlling === box.name" class="dm-busy">处理中…</span>
          </div>
        </div>
        <div v-if="probe?.ok && probe.list.stoppedCount" class="empty-hint">
          另有 {{ probe.list.stoppedCount }} 个已停止（右键菜单可启动/删除，先展开侧栏容器列表）
        </div>
      </template>

      <!-- ============ 镜像页 ============ -->
      <template v-else>
        <div class="dm-toolbar">
          <input
            v-model="pullRef"
            class="dm-pull-input"
            type="text"
            placeholder="拉取镜像，如 nginx:alpine"
            spellcheck="false"
            :disabled="pulling"
            @keydown.enter="pull"
          />
          <button class="btn" :disabled="pulling || !pullRef.trim()" @click="pull">
            {{ pulling ? '拉取中…' : '拉取' }}
          </button>
          <button class="btn" :disabled="cleanRunning" @click="openCleanup">清理</button>
          <button
            class="icon-btn"
            :class="{ dim: imagesLoading }"
            title="刷新镜像列表"
            @click="refreshImages"
          >
            <Icon name="refresh" :size="14" />
          </button>
        </div>
        <div v-if="pulling" class="dm-pull-line" :title="pullLine">
          <span class="dm-pull-text">{{ pullLine || '正在拉取…' }}</span>
          <button class="icon-btn dm-pull-x" title="取消拉取" @click="cancelPull">
            <Icon name="x" :size="12" />
          </button>
        </div>

        <div v-if="imagesLoading && !images" class="empty-hint">
          <Spinner text="正在列出镜像…" />
        </div>
        <div v-else-if="imagesError" class="empty-hint error">
          {{ imagesError }}
          <button class="retry" @click="refreshImages">重试</button>
        </div>
        <div v-else-if="images && !images.length" class="empty-hint">这台设备上没有镜像</div>
        <div v-else-if="images" class="dm-list" :class="{ dim: imagesLoading }">
          <div
            v-for="img in images"
            :key="`${img.repository}:${img.tag}:${img.id}`"
            class="dm-row dm-img-row"
            :title="`${img.repository}:${img.tag}\n${img.id}\n${img.size} · ${img.createdSince}`"
          >
            <span class="dm-row-main">
              <span class="dm-row-name">
                {{ img.repository }}:{{ img.tag }}
                <span v-if="!img.inUse" class="dm-tag-unused">未使用</span>
              </span>
              <span class="dm-row-sub">{{ img.id }} · {{ img.size }} · {{ img.createdSince }}</span>
            </span>
            <span v-if="imgBusy === `${img.repository}:${img.tag}`" class="dm-busy">处理中…</span>
            <span v-else-if="exporting === `${img.repository}:${img.tag}`" class="dm-busy">导出中…</span>
            <span v-else class="dm-row-actions">
              <button
                class="icon-btn"
                title="导出为 tar（经下载队列保存到本地）"
                @click="exportImage(img)"
              >
                <Icon name="download" :size="13" />
              </button>
              <button
                class="icon-btn danger"
                :class="{ dim: img.inUse }"
                :title="img.inUse ? '有容器在引用这个镜像，先删容器才能删它' : '删除镜像'"
                @click="!img.inUse && removeImage(img)"
              >
                <Icon name="trash" :size="13" />
              </button>
            </span>
          </div>
        </div>
      </template>

      <!-- ============ 清理对话框（1Panel 口径） ============ -->
      <div v-if="cleanVisible" class="overlay dm-clean-overlay" @click.self="cleanVisible = false">
        <div class="dialog pop-surface dm-clean">
          <div class="dm-clean-head">
            <span>清理镜像</span>
            <button class="icon-btn" title="关闭" @click="cleanVisible = false">
              <Icon name="x" :size="13" />
            </button>
          </div>

          <div v-if="cleanLoading" class="empty-hint"><Spinner text="正在统计空间…" /></div>
          <template v-else>
            <div v-if="dfRows.length" class="dm-df">
              <div class="dm-df-row dm-df-head">
                <span>类型</span><span>数量</span><span>占用</span><span>可回收</span>
              </div>
              <div v-for="r in dfRows" :key="r.type" class="dm-df-row">
                <span>{{ r.type }}</span><span>{{ r.count }}</span>
                <span>{{ r.size }}</span><span>{{ r.reclaimable }}</span>
              </div>
            </div>

            <label class="dm-clean-opt">
              <input v-model="cleanDangling" type="checkbox" />
              <span>
                悬空镜像（{{ danglingImages.length }} 个）
                <span class="dm-clean-sub">没有标签的 &lt;none&gt; 镜像，多是构建残留</span>
              </span>
            </label>
            <label class="dm-clean-opt">
              <input v-model="cleanUnused" type="checkbox" />
              <span>
                未使用镜像（{{ unusedImages.length }} 个）
                <span class="dm-clean-sub">没有任何容器引用；勾上会连悬空镜像一起清</span>
              </span>
            </label>
            <label class="dm-clean-opt">
              <input v-model="cleanBuildCache" type="checkbox" />
              <span>
                构建缓存{{ buildCacheReclaimable ? `（可回收 ${buildCacheReclaimable}）` : '' }}
                <span class="dm-clean-sub">docker build 留下的缓存层，清了不影响镜像和容器</span>
              </span>
            </label>

            <div class="dm-clean-foot">
              <button class="btn" @click="cleanVisible = false">取消</button>
              <button
                class="btn danger"
                :disabled="cleanRunning || (!cleanDangling && !cleanUnused && !cleanBuildCache)"
                @click="runCleanup"
              >
                {{ cleanRunning ? '清理中…' : '开始清理' }}
              </button>
            </div>
          </template>
        </div>
      </div>

      <ContextMenu
        v-if="ctrMenu"
        :x="ctrMenu.x"
        :y="ctrMenu.y"
        :items="ctrMenuItems"
        @select="onCtrMenuSelect"
        @close="ctrMenu = null"
      />
    </div>
  </div>
</template>

<style scoped>
/* 右侧抽屉：遮罩复用全局 .overlay，抽屉本体从右边贴进来 */
.dm-overlay {
  justify-content: flex-end;
  align-items: stretch;
}
.dm-drawer {
  width: 480px;
  max-width: 92vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 0;
  border-left: 1px solid var(--border);
}
.dm-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
  border-bottom: 1px solid var(--border);
}
.dm-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--fg);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 2px;
}
.dm-tab {
  border: none;
  background: none;
  padding: 3px var(--sp-3);
  border-radius: var(--r-xs);
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  cursor: pointer;
}
.dm-tab.on {
  background: var(--bg-active);
  color: var(--fg);
}
.dm-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
}
.dm-hint {
  flex: 1;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.dm-pull-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 var(--sp-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  outline: none;
  font-family: inherit;
  font-size: var(--fs-sm);
  color: var(--fg);
}
.dm-pull-input:focus {
  border-color: var(--accent);
}
.dm-pull-line {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3) var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--accent-text);
}
.dm-pull-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-pull-x {
  width: 20px;
  height: 20px;
  padding: 0;
  flex-shrink: 0;
  color: var(--fg-muted);
}
.dm-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--sp-2) var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dm-list.dim {
  opacity: 0.55;
  pointer-events: none;
}
.dm-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 5px var(--sp-2);
  border-radius: var(--r-sm);
  cursor: context-menu;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.dm-row:hover {
  background: var(--bg-hover);
}
.dm-img-row {
  cursor: default;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  flex-shrink: 0;
  background: var(--fg-muted);
}
.dot.running {
  background: var(--success-text);
}
.dot.paused,
.dot.starting {
  background: var(--warning-text);
}
.dot.unhealthy {
  background: var(--danger-text);
}
.dm-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.dm-row-name {
  font-size: var(--fs-sm);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-row-sub {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-tag-unused {
  margin-left: var(--sp-1);
  padding: 0 5px;
  border-radius: var(--r-pill);
  background: var(--bg-active);
  color: var(--fg-muted);
  font-size: var(--fs-xs);
}
.dm-row-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.dm-row-actions .icon-btn.dim {
  opacity: 0.35;
  cursor: not-allowed;
}
.dm-busy {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--accent-text);
}

/* 清理对话框：抽屉里再叠一层居中弹窗 */
.dm-clean-overlay {
  position: absolute;
  inset: 0;
}
.dm-clean {
  width: 380px;
  max-width: calc(100% - 48px);
  padding: var(--sp-3);
}
.dm-clean-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--fg);
  margin-bottom: var(--sp-2);
}
.dm-df {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  margin-bottom: var(--sp-3);
  overflow: hidden;
}
.dm-df-row {
  display: grid;
  grid-template-columns: 1.4fr 0.6fr 1fr 1.2fr;
  gap: var(--sp-2);
  padding: 4px var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--fg-secondary);
}
.dm-df-row + .dm-df-row {
  border-top: 1px solid var(--border);
}
.dm-df-head {
  color: var(--fg-muted);
  background: var(--bg-hover);
}
.dm-clean-opt {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
  font-size: var(--fs-sm);
  color: var(--fg);
  cursor: pointer;
}
.dm-clean-opt input {
  margin-top: 3px;
}
.dm-clean-sub {
  display: block;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
.dm-clean-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.retry {
  margin-left: var(--sp-2);
}
</style>

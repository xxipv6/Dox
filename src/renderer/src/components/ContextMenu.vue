<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import Icon, { type IconName } from './Icon.vue'
import { useEscapeToClose } from '../composables/useEscapeToClose'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: IconName
  /** 危险操作（删除）用红色，和行尾按钮的 danger 一致 */
  danger?: boolean
  disabled?: boolean
  /** 该项渲染为分组分隔线（label 留空即可，id 仅作 key） */
  separator?: boolean
  /** 右侧快捷键提示（如 ↩ / F2 / ⌘⌫），按平台由调用方给文案 */
  hint?: string
}

const props = defineProps<{
  /** 视口坐标（clientX / clientY），和鼠标事件直接对齐 */
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  select: [id: string]
  close: []
}>()

const el = ref<HTMLElement | null>(null)
const pos = ref({ left: props.x, top: props.y })

/**
 * 贴边翻转。
 *
 * 光标停在窗口右下角时，菜单会整个溢出到屏幕外、只剩一半能点。所以先按
 * 光标位置摆，量出实际尺寸，溢出就翻到光标另一侧。必须等渲染完才量得到，
 * 因此放在 nextTick 之后。
 */
async function place(): Promise<void> {
  pos.value = { left: props.x, top: props.y }
  await nextTick()
  const box = el.value?.getBoundingClientRect()
  if (!box) return
  const margin = 8
  pos.value = {
    left:
      props.x + box.width > window.innerWidth - margin
        ? Math.max(margin, props.x - box.width)
        : props.x,
    top:
      props.y + box.height > window.innerHeight - margin
        ? Math.max(margin, props.y - box.height)
        : props.y
  }
}

onMounted(place)
watch(() => [props.x, props.y], place)

// 菜单是 v-if 挂载的，存在即打开
useEscapeToClose(
  () => true,
  () => emit('close')
)
</script>

<template>
  <Teleport to="body">
    <!-- 铺满一层透明背板：点别处、滚轮、再按右键都关掉它 -->
    <div
      class="menu-backdrop"
      @mousedown="emit('close')"
      @contextmenu.prevent="emit('close')"
      @wheel="emit('close')"
    ></div>
    <!--
      appear 是必须的：这个组件的挂载/卸载由父组件的 v-if 决定（存在即打开），
      而 <Transition> 默认不在首次渲染时播放进场动画。代价是**退场是瞬时的** ——
      要有退场动画得把 v-if 挪进组件内部，那是另一件事。
    -->
    <Transition name="pop" appear>
      <div
        ref="el"
        class="context-menu pop-surface"
        :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
      >
        <template v-for="item in items" :key="item.id">
          <div v-if="item.separator" class="menu-separator"></div>
          <button
            v-else
            class="menu-item"
            :class="{ danger: item.danger }"
            :disabled="item.disabled"
            @click="emit('select', item.id)"
          >
            <Icon v-if="item.icon" :name="item.icon" :size="14" />
            <span>{{ item.label }}</span>
            <span v-if="item.hint" class="menu-hint">{{ item.hint }}</span>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/*
 * 菜单项本身（含悬停/按下/禁用）是 styles.css 里的全局 .menu-item ——
 * 终端里的右键菜单、溢出清单将来都该长成这一个样子。
 * 这里只留「菜单这一层」的差异：位置、宽度、内衬。
 */
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-menu);
}
.context-menu {
  position: fixed;
  /* +1：内容必须压在它自己那层透明背板之上 */
  z-index: calc(var(--z-menu) + 1);
  min-width: 168px;
  padding: var(--sp-1);
  border-radius: var(--r-md);
}
</style>

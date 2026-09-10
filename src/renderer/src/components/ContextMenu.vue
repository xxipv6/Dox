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
    <div ref="el" class="context-menu" :style="{ left: pos.left + 'px', top: pos.top + 'px' }">
      <button
        v-for="item in items"
        :key="item.id"
        class="menu-item"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        @click="emit('select', item.id)"
      >
        <Icon v-if="item.icon" :name="item.icon" :size="14" />
        <span>{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
}
.context-menu {
  position: fixed;
  z-index: 201;
  min-width: 168px;
  padding: 4px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  box-shadow: var(--shadow-lg);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  border-radius: var(--r-xs);
  color: var(--fg);
  font-size: var(--fs-md);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.menu-item:hover:not(:disabled) {
  background: var(--bg-hover);
}
.menu-item.danger {
  color: var(--danger-text);
}
.menu-item:disabled {
  color: var(--fg-muted);
  cursor: default;
}
</style>

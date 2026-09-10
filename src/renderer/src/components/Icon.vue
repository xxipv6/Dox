<script setup lang="ts">
import { computed } from 'vue'

/**
 * 统一图标。
 *
 * 不再用 emoji 或文字字形（📁 ⬆ ⚙ ⌨ …）当图标：那些字符在不同平台上
 * 渲染结果差别极大 —— 有的是彩色 emoji 块、有的是细线字形，同一排按钮
 * 放在一起像没做完。这里全部走内联 SVG，用 currentColor 取色，
 * 线宽固定，所以深浅主题下都跟文字同色、粗细一致。
 */
export type IconName =
  | 'plus' | 'minus' | 'x' | 'check'
  | 'chevron-up' | 'chevron-down' | 'chevron-right' | 'chevron-left'
  | 'arrow-up' | 'arrow-down' | 'refresh' | 'play' | 'pencil' | 'trash' | 'check-square'
  | 'folder' | 'folder-plus' | 'file' | 'link'
  | 'upload' | 'download' | 'follow' | 'paste' | 'terminal' | 'server'
  | 'split-right' | 'split-down' | 'panel-left'
  | 'key' | 'alert' | 'settings' | 'sun' | 'moon' | 'box' | 'zap'
  // 自绘标题栏的窗口按钮（macOS 用系统红绿灯，不会用到这两个）
  | 'square' | 'restore'
  | 'search'

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 14 })

/**
 * 每个图标是一组 path 的 d 属性；24×24 视口，描边绘制。
 * `Record<IconName, string[]>` 而不是 Record<string,...>：漏写某个图标时
 * 由类型检查报错，而不是运行时静默渲染成空白。
 */
const PATHS: Record<IconName, string[]> = {
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  x: ['M6 6l12 12M18 6L6 18'],
  check: ['M20 6L9 17l-5-5'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'arrow-up': ['M12 19V5M5 12l7-7 7 7'],
  'arrow-down': ['M12 5v14M5 12l7 7 7-7'],
  refresh: ['M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8', 'M21 3v5h-5'],
  play: ['M7 5l12 7-12 7z'],
  pencil: ['M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16z', 'M14.5 5.5l4 4'],
  trash: [
    'M4 7h16',
    'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
    'M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12'
  ],
  'check-square': [
    'M9 11l3 3L21 4',
    'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'
  ],

  folder: ['M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  'folder-plus': [
    'M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'M12 11.5v5M9.5 14h5'
  ],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  link: [
    'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7',
    'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'
  ],

  upload: ['M12 15V4M8 8l4-4 4 4', 'M4 16v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2'],
  download: ['M12 4v11M8 11l4 4 4-4', 'M4 16v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2'],
  follow: ['M4 8h13M14 5l3 3-3 3', 'M20 16H7M10 13l-3 3 3 3'],
  paste: ['M9 11l-5 5 5 5', 'M4 16h10a6 6 0 0 0 6-6V4'],
  terminal: ['M4 7l5 5-5 5', 'M12 17h8'],
  server: [
    'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
    'M4 15a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
    'M7.5 7h.01M7.5 17h.01'
  ],

  'split-right': ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M13.5 4v16'],
  'split-down': ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M4 13.5h16'],
  'panel-left': ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M9.5 4v16'],

  key: ['M3 17a4 4 0 1 0 8 0 4 4 0 0 0-8 0', 'M9.9 14.1 20 4', 'M16.5 7.5 19 10'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4M12 17h.01'],
  // Lucide settings；14px 下会糊，调用处给 16px
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'
  ],

  // 主题切换按钮：显示的是**当前**主题，点一下切到另一个
  sun: [
    'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
    'M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'
  ],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],

  // 容器：一个立方体
  box: [
    'M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z',
    'M3.3 7L12 12l8.7-5',
    'M12 22V12'
  ],
  // 快捷命令：闪电
  zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],

  // 窗口按钮：□ 最大化 / ❐ 还原（两个错位的方框）
  square: ['M5.5 5.5h13v13h-13z'],
  restore: ['M8.5 8.5V6a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-2.5', 'M5.5 8.5h9.5v9.5h-9.5z'],

  // 搜索：放大镜
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.35-4.35']
}

const paths = computed(() => PATHS[props.name] ?? [])
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.icon {
  display: block;
  flex-shrink: 0;
}
</style>

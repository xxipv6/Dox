<script setup lang="ts">
/**
 * 应用标记：天蓝→草绿渐变圆角方块 + 白色 `>_`。
 *
 * 这是 build/icon.png 的矢量副本 —— 侧栏顶栏用它，让「界面里的标记」和
 * 「任务栏/安装包上的图标」是同一个东西。用内联 SVG 而不是引一张 png：
 * 16~24px 下矢量才不糊，而且渐变写死在 SVG 里、与主题无关
 * （图标本来就是要在任何底色上都立得住的，不跟着主题变）。
 *
 * ⚠ 几何数字与 scripts/generate-icon.mjs 里的 CHEVRON/BAR/STROKE/RADIUS 一一对应，
 * 改一边必须同时改另一边，否则界面上那个和任务栏上那个会长得不一样。
 * 坐标系是 512×512（生成脚本的设计基准），不是图标组件惯用的 24×24。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 20 })

/**
 * 渐变 id。所有实例用的是**完全相同**的渐变，所以固定 id 是安全的：
 * 同 id 出现多次时浏览器只认第一个，而第一个和后面几个画出来一模一样。
 * （真正会出事的是「同 id、不同内容」，那才会静默引用错。）
 */
const gradId = 'dox-logo-grad'
</script>

<template>
  <svg
    class="logo-mark"
    :width="size"
    :height="size"
    viewBox="0 0 512 512"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" />
        <stop offset="45%" stop-color="#0ea5e9" />
        <stop offset="100%" stop-color="#10b981" />
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="112" :fill="`url(#${gradId})`" />
    <path
      d="M121 170L233 256L121 342"
      fill="none"
      stroke="#fff"
      stroke-width="32"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <rect x="271" y="324" width="136" height="34" fill="#fff" />
  </svg>
</template>

<style scoped>
.logo-mark {
  display: block;
  flex-shrink: 0;
  /* 圆角在 20px 下会有轻微锯齿，一点点投影让它从浅色侧栏上「浮」起来 */
  filter: drop-shadow(0 1px 2px rgba(14, 165, 233, 0.28));
}
</style>

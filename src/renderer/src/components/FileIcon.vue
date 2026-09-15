<script setup lang="ts">
import { computed } from 'vue'
import type { FileEntry } from '@shared/types'
import { useSettingsStore } from '../stores/settings'
import Icon from './Icon.vue'
import setiTheme from '../assets/file-icons/vs-seti-icon-theme.json'

/**
 * 文件类型图标：VS Code **内置 Seti 主题**的原版复刻。
 *
 * 数据（seti.woff 字体 + vs-seti-icon-theme.json 映射）原样取自 VS Code 仓库
 * extensions/theme-seti/icons/，解析规则也照它的来：
 *   文件名精确命中（fileNames）→ 扩展名（fileExtensions）→ 语言表（BY_EXT，
 *   对应 VS Code 语言注册中心走 languageIds 的那部分）→ _default。
 * 深色用主表、浅色用 *_light 变体（VS Code 的 light 节）。
 *
 * 目录/符号链接仍走全局线性 Icon（那是界面词汇表，不属于文件图标主题）。
 */

interface SetiDef {
  fontCharacter: string
  fontColor: string
}
const defs = setiTheme.iconDefinitions as unknown as Record<string, SetiDef>
const themeFileNames = setiTheme.fileNames as Record<string, string>
const themeFileExts = setiTheme.fileExtensions as Record<string, string>

/** VS Code 走语言注册中心（languageIds）的那些文件名/扩展名，我们没有语言注册表，等价展开 */
const BY_NAME: Record<string, string> = {
  dockerfile: '_docker',
  'docker-compose.yml': '_docker',
  'docker-compose.yaml': '_docker',
  'compose.yml': '_docker',
  'compose.yaml': '_docker',
  '.gitignore': '_git',
  '.gitkeep': '_git',
  '.gitattributes': '_git',
  '.gitmodules': '_git',
  '.env': '_config',
  makefile: '_makefile',
  gnumakefile: '_makefile',
  'package.json': '_json',
  'package-lock.json': '_json',
  'nginx.conf': '_config'
}

const BY_EXT: Record<string, string> = {
  ts: '_typescript', mts: '_typescript', cts: '_typescript',
  tsx: '_react',
  js: '_javascript', mjs: '_javascript', cjs: '_javascript',
  jsx: '_react',
  json: '_json', map: '_json',
  md: '_markdown', markdown: '_markdown',
  yml: '_yml', yaml: '_yml',
  py: '_python', go: '_go2', vue: '_vue',
  sh: '_shell', bash: '_shell', zsh: '_shell', fish: '_shell',
  ps1: '_powershell', bat: '_windows', cmd: '_windows',
  c: '_c', h: '_c',
  cpp: '_cpp', cc: '_cpp', cxx: '_cpp', hpp: '_cpp',
  cs: '_c-sharp', java: '_java', kt: '_kotlin', kts: '_kotlin',
  rs: '_rust', rb: '_ruby', php: '_php', swift: '_swift', lua: '_lua',
  sql: '_db', db: '_db', sqlite: '_db',
  css: '_css', scss: '_sass', less: '_less',
  html: '_html_3', htm: '_html_3', xml: '_xml',
  env: '_config', ini: '_config', conf: '_config', cfg: '_config', properties: '_config',
  gz: '_zip', tgz: '_zip', tar: '_zip', bz2: '_zip', xz: '_zip', '7z': '_zip', rar: '_zip'
}

const settings = useSettingsStore()
const props = withDefaults(defineProps<{ entry: FileEntry; size?: number }>(), { size: 15 })

const def = computed<SetiDef | null>(() => {
  if (props.entry.isDir || props.entry.isSymlink) return null
  const name = props.entry.name.toLowerCase()
  let id = themeFileNames[name] ?? BY_NAME[name]
  if (!id) {
    const dot = name.lastIndexOf('.')
    if (dot > 0) id = themeFileExts[name.slice(dot + 1)] ?? BY_EXT[name.slice(dot + 1)]
  }
  id ??= '_default'
  // 浅色主题用 *_light 变体（VS Code light 节：同一字符、更深一档的颜色）
  if (settings.resolvedTheme === 'light' && defs[`${id}_light`]) return defs[`${id}_light`]
  return defs[id] ?? defs['_default']
})

const glyph = computed(() => {
  const d = def.value
  if (!d) return ''
  // "\E001" 形式的 PUA 码位 → 实际字符
  return String.fromCodePoint(parseInt(d.fontCharacter.replace('\\', '0x'), 16))
})
</script>

<template>
  <Icon v-if="entry.isDir" class="file-icon dir" name="folder" :size="size" />
  <Icon v-else-if="entry.isSymlink" class="file-icon" name="link" :size="size" />
  <span
    v-else
    class="seti-glyph"
    :style="{ color: def?.fontColor, fontSize: `${size}px` }"
    aria-hidden="true"
  >{{ glyph }}</span>
</template>

<style scoped>
@font-face {
  font-family: 'dox-seti';
  src: url('../assets/file-icons/seti.woff') format('woff');
  font-weight: normal;
  font-style: normal;
}
.file-icon {
  flex-shrink: 0;
  color: var(--fg-muted);
}
.file-icon.dir {
  color: var(--accent-text);
}
.seti-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.2em;
  font-family: 'dox-seti';
  /* VS Code 给这套字体配的是 150% 字号：字形本身设计得偏小 */
  line-height: 1;
  speak: none;
}
</style>

import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'

/** 按扩展名选高亮。命中的只是语法着色，不命中也能正常编辑。 */
const BY_EXT: Record<string, () => Extension> = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  jsonc: () => json(),
  py: () => python(),
  html: () => html(),
  htm: () => html(),
  vue: () => html(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  md: () => markdown(),
  markdown: () => markdown(),
  yml: () => yaml(),
  yaml: () => yaml(),
  xml: () => xml(),
  svg: () => xml(),
  plist: () => xml(),
  sh: () => StreamLanguage.define(shell),
  bash: () => StreamLanguage.define(shell),
  zsh: () => StreamLanguage.define(shell),
  ps1: () => StreamLanguage.define(powerShell),
  psm1: () => StreamLanguage.define(powerShell),
  toml: () => StreamLanguage.define(toml),
  sql: () => StreamLanguage.define(standardSQL),
  ini: () => StreamLanguage.define(properties),
  cfg: () => StreamLanguage.define(properties),
  conf: () => StreamLanguage.define(properties),
  env: () => StreamLanguage.define(properties)
}

/** 没有扩展名但靠文件名就能认出来的 */
const BY_NAME: Record<string, () => Extension> = {
  dockerfile: () => StreamLanguage.define(dockerFile),
  'containerfile': () => StreamLanguage.define(dockerFile),
  makefile: () => StreamLanguage.define(shell),
  'nginx.conf': () => StreamLanguage.define(nginx),
  'my.cnf': () => StreamLanguage.define(properties),
  'pg_hba.conf': () => StreamLanguage.define(properties),
  '.bashrc': () => StreamLanguage.define(shell),
  '.bash_profile': () => StreamLanguage.define(shell),
  '.zshrc': () => StreamLanguage.define(shell),
  '.profile': () => StreamLanguage.define(shell),
  '.env': () => StreamLanguage.define(properties)
}

/**
 * 编辑器语言扩展。
 * nginx 必须在 properties 之前判：`nginx.conf` 的扩展名 .conf 会命中
 * properties，两者都是纯文本规则，认错了语法着色会整个走样。
 */
export function languageFor(path: string): Extension[] {
  const name = path.split('/').pop()?.toLowerCase() ?? ''

  const byName = BY_NAME[name]
  if (byName) return [byName()]

  // *.conf 里只有 nginx 单独认，其余交给 properties
  if (name.endsWith('.conf') && name.includes('nginx')) {
    return [StreamLanguage.define(nginx)]
  }

  // 认不出就返回空数组：没有高亮，但编辑器照常能编辑
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return BY_EXT[ext] ? [BY_EXT[ext]()] : []
}


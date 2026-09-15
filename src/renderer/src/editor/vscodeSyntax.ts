import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'

/**
 * VS Code 内置主题的语法配色移植：深色 = Dark+，浅色 = Light+。
 *
 * 只搬「语义标签 → 颜色」这一张表。字号/行高/选区/gutter 那些 chrome 归
 * FileEditor 的 chromeTheme 管（走 CSS 变量跟界面主题走），这里一概不碰。
 * 色值本身是第三方主题数据（与 assets/file-icons 的 Seti 同性质），
 * 不受 styles.css 令牌约束；改色请先对照 VS Code 原版，别凭感觉调。
 *
 * 规则顺序即优先级：越靠后越具体（function(...) 要放在裸 variableName 后面）。
 */

const darkPlus = HighlightStyle.define([
  { tag: [t.comment, t.docComment], color: '#6A9955' },
  // 关键字分三档：普通蓝 / 流程控制紫 / 声明蓝（VS Code Dark+ 的标志性分层）
  { tag: [t.keyword, t.operatorKeyword, t.definitionKeyword, t.self], color: '#569CD6' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#C586C0' },
  { tag: t.string, color: '#CE9178' },
  { tag: [t.escape, t.special(t.string)], color: '#D7BA7D' },
  { tag: t.regexp, color: '#D16969' },
  { tag: [t.number, t.integer, t.float], color: '#B5CEA8' },
  { tag: [t.bool, t.null, t.atom], color: '#569CD6' },
  { tag: [t.typeName, t.className, t.namespace], color: '#4EC9B0' },
  // string/number 这类内建类型在 Dark+ 里是关键字蓝，不是类名青
  { tag: t.standard(t.typeName), color: '#569CD6' },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: '#9CDCFE' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.annotation], color: '#DCDCAA' },
  { tag: t.tagName, color: '#569CD6' },
  { tag: t.attributeValue, color: '#CE9178' },
  // Markdown 源码档：标题/加粗蓝、行内代码橙（Dark+ 的 markdown 规则）
  { tag: t.heading, color: '#569CD6', fontWeight: 'bold' },
  { tag: t.strong, color: '#569CD6', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.monospace, color: '#CE9178' },
  { tag: t.quote, color: '#6A9955' },
  { tag: t.link, color: '#4E94CE' },
  { tag: t.url, color: '#CE9178' },
  { tag: t.invalid, color: '#F44747' }
])

const lightPlus = HighlightStyle.define([
  { tag: [t.comment, t.docComment], color: '#008000' },
  { tag: [t.keyword, t.operatorKeyword, t.definitionKeyword, t.self], color: '#0000FF' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#AF00DB' },
  { tag: t.string, color: '#A31515' },
  { tag: [t.escape, t.special(t.string)], color: '#EE0000' },
  { tag: t.regexp, color: '#811F3F' },
  { tag: [t.number, t.integer, t.float], color: '#098658' },
  { tag: [t.bool, t.null, t.atom], color: '#0000FF' },
  { tag: [t.typeName, t.className, t.namespace], color: '#267F99' },
  { tag: t.standard(t.typeName), color: '#0000FF' },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: '#001080' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.annotation], color: '#795E26' },
  { tag: t.tagName, color: '#800000' },
  { tag: t.attributeValue, color: '#0000FF' },
  { tag: t.heading, color: '#800000', fontWeight: 'bold' },
  { tag: t.strong, color: '#000080', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.monospace, color: '#A31515' },
  { tag: t.quote, color: '#008000' },
  { tag: t.link, color: '#0000FF' },
  { tag: t.url, color: '#A31515' },
  { tag: t.invalid, color: '#CD3131' }
])

/**
 * 语法高亮扩展。
 *
 * **不能加 `{ fallback: true }`**：那个选项的意思是「别人都没配这个标签时才轮到我」，
 * 而 basicSetup 里已经有一份 defaultHighlightStyle —— 加了 fallback 就等于让它
 * 全面压过这套 VS Code 配色（标题只剩加粗、URL 会被涂成 #219 的紫蓝，实测踩过）。
 * 没列到的标签保持不染色、继承正文色，这正是 VS Code 的默认前景行为。
 */
export const vscodeDarkSyntax: Extension = syntaxHighlighting(darkPlus)
export const vscodeLightSyntax: Extension = syntaxHighlighting(lightPlus)

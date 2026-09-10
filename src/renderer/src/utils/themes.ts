import type { ITheme } from '@xterm/xterm'

export interface TerminalThemePreset {
  id: string
  name: string
  theme: ITheme
}

/**
 * 「跟随界面主题」哨兵值。
 *
 * 它**不是**一个预设，所以不在 TERMINAL_THEMES 里 —— 界面切到亮色时它解析成
 * sky-light，切到深色时解析成 midnight-slate。把它混进预设数组会让设置弹窗
 * 多出一个没有自己配色的选项，点上去那个色板小方块也无从渲染。
 */
export const AUTO_THEME_ID = 'auto'

/** auto 在两套界面主题下分别落到哪个预设 */
const AUTO_PAIRS: Record<'light' | 'dark', string> = {
  light: 'sky-light',
  dark: 'midnight-slate'
}

/**
 * 选择终端配色。
 *
 * 前两套（sky-light / midnight-slate）与界面主题同源，是 auto 的落点；
 * 后面五套是经典配色，**原样保留**作为手动覆盖 —— 老用户的选择不该被
 * 静默改掉，哪怕界面已经换了皮。
 */
export const TERMINAL_THEMES: TerminalThemePreset[] = [
  {
    id: 'sky-light',
    name: '晴空（跟随界面·亮）',
    theme: {
      background: '#ffffff',
      foreground: '#1e293b',
      cursor: '#0ea5e9',
      cursorAccent: '#ffffff',
      // 比 --accent-soft 稍重一点：选中色是要压在白色上的，太淡会看不见。
      // selectionForeground 必须显式给：xterm 不设时自己算，浅底 + 浅前景会算出
      // 几乎看不清的字
      selectionBackground: '#d6edfb',
      selectionForeground: '#1e293b',
      black: '#24292f',
      red: '#cf222e',
      green: '#1a7f37',
      yellow: '#9a6700',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#116329',
      brightYellow: '#7d4e00',
      brightBlue: '#0ea5e9',
      brightMagenta: '#a475f9',
      brightCyan: '#0e7490',
      brightWhite: '#8c959f'
    }
  },
  {
    id: 'midnight-slate',
    name: '冷夜（跟随界面·暗）',
    theme: {
      background: '#0b1220',
      foreground: '#e2e8f0',
      cursor: '#38bdf8',
      cursorAccent: '#0b1220',
      selectionBackground: '#1e3a5f',
      selectionForeground: '#e2e8f0',
      black: '#1e293b',
      red: '#f87171',
      green: '#34d399',
      yellow: '#fbbf24',
      blue: '#38bdf8',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#cbd5e1',
      brightBlack: '#475569',
      brightRed: '#fca5a5',
      brightGreen: '#6ee7b7',
      brightYellow: '#fcd34d',
      brightBlue: '#7dd3fc',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#f1f5f9'
    }
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    }
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    theme: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#d19a66',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#d19a66',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    theme: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      selectionBackground: '#49483e',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#e6db74',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5'
    }
  },
  {
    id: 'light',
    name: '亮色',
    theme: {
      background: '#ffffff',
      foreground: '#383a42',
      cursor: '#526eff',
      selectionBackground: '#e5e5e6',
      black: '#383a42',
      red: '#e45649',
      green: '#50a14f',
      yellow: '#c18401',
      blue: '#4078f2',
      magenta: '#a626a4',
      cyan: '#0184bc',
      // 原来是 #fafafa —— 压在白底上等于隐身，任何用 ANSI 白输出文字的程序
      // 都变成一片空白。浅色底的主题里 white 本来就该映射成中灰。
      white: '#6e7781',
      brightBlack: '#696c77',
      brightRed: '#e45649',
      brightGreen: '#50a14f',
      brightYellow: '#c18401',
      brightBlue: '#4078f2',
      brightMagenta: '#a626a4',
      brightCyan: '#0184bc',
      // 同上：白底上的 brightWhite 也得往灰里落，才看得见
      brightWhite: '#8c959f'
    }
  }
]

export function getThemePreset(id: string): TerminalThemePreset {
  return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0]
}

/**
 * 把 `themeId`（可能是 auto 哨兵）解析成真正要用的预设。
 *
 * 第二个参数是**已解析**的深浅（'system' 已经落到亮或暗），不是 UiTheme ——
 * auto 需要一个确定的答案，拿到 'system' 是没法查表的。
 *
 * 单独一个函数而不是塞进 `currentPreset` computed 里：这个映射是纯的，
 * 单独放可以一眼看全「什么设置配什么配色」，也方便单独验。
 */
export function resolveThemePreset(
  themeId: string,
  resolvedTheme: 'light' | 'dark'
): TerminalThemePreset {
  if (themeId === AUTO_THEME_ID) return getThemePreset(AUTO_PAIRS[resolvedTheme])
  return getThemePreset(themeId)
}

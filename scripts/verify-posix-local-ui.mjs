/**
 * 端到端验证：真实应用（out/ 产物）里本地终端能开出 POSIX shell，
 * 且 OSC 7 cwd 上报驱动标签标题（本地 · <目录>）。
 * 对应的真实 bug：POSIX 分支曾给 zsh 塞 bash 的 --rcfile，本地终端打开即死。
 * 仅在 darwin/linux 跑；前置：npm run build。
 */
import { _electron as electron } from 'playwright'

if (process.platform === 'win32') {
  console.log('Windows 侧由 verify-render.mjs 等覆盖，跳过')
  process.exit(0)
}

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

// 布局恢复可能带回别的标签，显式新建一个本地终端
await win.locator('.tab-new').click()
// 等新标签接管「活动」位置（标题以「本地」开头）再敲键盘 ——
// 刚点完就打字，键事件会落进旧的 SSH 标签，命令根本没进 zsh
await win.waitForFunction(
  () => document.querySelector('.tab.active')?.textContent?.includes('本地'),
  undefined,
  { timeout: 10000 }
)
// 本地终端标签标题：integration 上报前是「本地终端」，上报后是「本地 · <目录>」
const tabTitle = () => win.locator('.tab.active').first().innerText().catch(() => '')
console.log('新标签标题:', JSON.stringify(await tabTitle()))

// 点击终端拿焦点，再敲 cd /tmp（每个标签各有一个容器，inactive 的是 display:none，
// 必须用 :visible 与「人看到的」统一口径，否则点到别的标签的缓冲区上）
await win.locator('.terminal-container:visible').first().click()
await win.keyboard.type('cd /tmp')
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)
const title = await tabTitle()
console.log('cd /tmp 后标签  :', JSON.stringify(title))

// 序列级断言（OSC 133 退出码等）归 verify-posix-integration.mjs；
// 这里只守「真实应用里终端活着 + cwd 驱动标签标题」这条端到端链路。
// （别去 DOM 里抠 .xterm-rows：webgl addon 接管后那个容器是空的。）
const ok = title.includes('tmp')
console.log(ok ? '\nPASS: zsh 终端工作 + cwd 上报生效' : '\nFAIL: 标签标题未跟随 cwd')
await app.close()
process.exit(ok ? 0 : 1)

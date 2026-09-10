# Dox 维护手册

给接手的人。README 讲「这是什么、做到哪一步」，这一份讲**怎么改才不出事**。

Dox 是 Electron 的 SSH 终端 + SFTP 文件管理器。它的复杂度不在功能数量，而在几处
「看起来能随便改、其实一改就静默出错」的地方 —— 这份文档主要是把它们摊开。

---

## 1. 跑起来

```bash
npm install
npm run dev          # 开发（HMR）
npm run typecheck    # 必须过：tsc(主/preload) + vue-tsc(渲染层) 两套
npm run build        # 产物到 out/
npm run pack:win     # 打包（会先跑 typecheck + build）
```

**TypeScript 钉在 `~5.9.3`，别升。** `vue-tsc` 目前与 TS 7 不兼容，升了渲染层的类型检查直接跑不动。
等 vue-tsc 跟上再一起升。

全工程 ESM（`"type": "module"`）。preload 因此要求 `sandbox: false` —— 安全边界由
`contextIsolation` 保证，渲染层只能通过 `window.api`（`src/preload/index.ts`）够到主进程。

### 用户数据在哪

`%APPDATA%/dox/`（macOS/Linux 对应 `app.getPath('userData')`）：

| 文件 | 内容 |
|---|---|
| `dox-config.json` | 已保存设备、快捷命令片段（密码经 safeStorage 加密） |
| `dox-settings.json` | 界面/终端主题、字号、连字、默认本地 shell |
| `dox-layout.json` | 上次退出时的标签布局 |
| `dox-known-hosts.json` | SSH 主机指纹 |

调试本地终端的原始字节流：`DOX_DEBUG_PTY=1 npm run dev`，日志写到 `%APPDATA%/dox/dox-pty-debug.log`。

---

## 2. 代码地图

```
src/
├── main/                      # 全部网络与进程操作都在这里，渲染层碰不到 ssh2/node-pty
│   ├── index.ts               # 窗口创建、生命周期、自绘标题栏的窗口事件
│   ├── theme.ts               # nativeTheme + 窗口底色（界面主题在渲染层，这里是它的影子）
│   ├── execError.ts           # CommandError：与传输层无关的命令失败模型
│   ├── ipc/index.ts           # 所有 IPC 路由集中注册
│   ├── ssh/
│   │   ├── SessionManager.ts  # ssh2 连接池、shell 数据流、心跳、断线重连
│   │   └── remoteExec.ts      # 一次性的 exec 往返（探测用），带 stdout/stderr 判别
│   ├── container/             # 容器终端（Docker/Podman）
│   ├── local/                 # 本地终端（node-pty）
│   ├── sftp/                  # SFTP + 传输队列
│   ├── forward/               # 端口转发
│   └── store/                 # electron-store 各持久化门面
├── preload/index.ts           # contextBridge → window.api，唯一的桥
├── shared/                    # 主/渲染共用：types、api 契约、ipc 通道名、sessionId 规则
└── renderer/src/
    ├── App.vue                # 布局骨架（标题栏 / 侧栏 / 标签栏 / 主区）
    ├── styles.css             # ★ 令牌层：颜色、圆角、间距、字号
    ├── utils/themes.ts        # xterm 终端配色预设（数据，不是样式）
    ├── stores/                # Pinia：sessions / settings / layout / editor
    └── components/            # 视图
```

### 会话 id 决定一切路由

`src/shared/sessionId.ts` 是理解这个项目的钥匙。输入、resize、断开这些通道**不分种类**，
全靠 id 前缀路由到不同的管理器：

| 前缀 | 承载 | 管理器 |
|---|---|---|
| `local-` | 本机 shell（node-pty） | `LocalPtyManager` |
| `container-` | 容器里的 shell | `ContainerManager` |
| 无前缀 | SSH 会话 | `SessionManager` |

另外 `LOCAL_CONTAINER_TARGET = 'local'` 是个**哨兵值**，表示「列本机的容器」——
用哨兵而不是 `null`，因为 `null` 已经被「没有可列的目标」占用了。

改这里之前先想清楚：新增一类会话时，把它接进前缀路由，就能白拿输入/resize/断开/SFTP 排除/重连排除
这一整套，不用写第二套 API。

---

## 3. 必须守住的约束

这几条不是风格偏好，破了会出真问题。

### 3.1 远端必须「无感」：不装 agent、不建文件、不留痕迹

红线的本义（项目负责人原话）：**不要一连上就往远端装 agent 之类的东西**。
具体到容器功能：

- **允许**：只读探测（`docker ps`）、`docker exec` 进已存在的容器、`docker logs`、
  以及用户**显式触发**的容器生命周期操作（start / stop / unpause / rm，
  经 `runtime.ts` 的 `CONTROL_VERBS` 白名单，渲染层字符串不直接进命令）。
- **禁止**：安装任何东西、建容器（run/create/pull）、拷贝文件进容器（cp）、
  在远端建文件（测试脚本除外，且只允许建临时文件并自己删掉）。

这条由 `verify-container.mjs` 的阶段 5 静态守着（扫 `src/main/container/` 有没有出现
`docker run/cp/build/pull/create`，外加 CONTROL_VERBS 白名单检查）。
**看到那条守卫红了就去改代码，不要去改守卫。**

同类约束：容器内**不做**文件浏览。VS Code Dev Containers 那条路要往容器里塞一个 server，
直接违反这一条。

### 3.2 容器标签不参与重连，也不进布局快照

容器会话单独一个 `ContainerManager`，不塞进 `SessionManager`。原因是：

- 塞进去，`disconnect()` 会掐断整条 SSH 连接、`sftp()` 会返回宿主机文件系统、
  `handleClosed()` 会把它拖进重连循环；
- 容器标签不进 `dox-layout.json` —— 父会话 id 重启即失效，存下来只会造出无法恢复的僵尸标签。

所以「容器标签不会自动重连」这件事来自**那段代码根本不存在**，不是靠 guard 拦的。

父 SSH 会话断开时，`ContainerManager.stopBySession()` **必须当场把 `closed` 状态发出去**。
只删表 + 关通道是不够的：通道随后的 `'close'` 事件走到 `handleClosed` 时已经查不到这条记录，
会直接 return —— 界面于是停在「已连接」，而终端其实早就死了。那是最糟的一种错：不报错，但显示的是假的。

### 3.3 颜色只能来自令牌层

`src/renderer/src/styles.css` 是**唯一**允许写死颜色的文件。组件里一律 `var(--token)`。

两类颜色分开：

- `--accent` 是「颜料档」：大块填充、进度条、装饰性高亮线
- `--accent-text` 是「文字档」：文字、图标、语义边框

分开的原因是真算过对比度：`#0ea5e9` 在白底上只有 **2.77:1**，当文字和图标都不合格；
`--accent-text`（`#0369a1`）是 5.9:1。状态色同理（`--success-text` / `--warning-text` / `--danger-text`）。
**深色下 `-text` 一律别名回基色** —— 令牌的契约两套主题一致，只有取值分叉。

新增令牌时：加在 `:root, :root[data-theme='light']` 与 `:root[data-theme='dark']` **两处**。

三块「自带主题系统」的表面各自接在：**xterm**（`term.options.theme` watch）、
**CodeMirror**（`Compartment` 就地重配，切主题不丢撤销历史）、
**原生控件**（`nativeTheme.themeSource` + CSS `color-scheme`，否则 `<select>` 弹出层在浅色下是深色的）。
再加自带配色的组件时，记得同样处理，别漏。

漏改检测交给 `verify-theme.mjs`：它在亮/深两套下遍历全 DOM 的计算样式，断言没有任何一处
等于旧调色板的 15 个值。**逐个人工核对 270 处不现实，漏一个在深色下看着完全正常、只有亮色才露黑。**

### 3.4 主题不闪

`html`/`body` 刻意**不刷底色**，底色的所有者是 `#app`，而主进程在建窗时按持久化的
`uiTheme` 设 `BrowserWindow.backgroundColor`。在主题落定前露出的是主进程算好的那一帧。

`src/main/theme.ts` 里的 `BACKGROUND` 值必须与 `styles.css` 里的 `--bg` **完全一致** ——
这是跨进程的重复，没有编译期约束，改一个记得改另一个。

### 3.5 自绘标题栏

Windows / Linux 上是 `frame: false`，macOS 上是 `titleBarStyle: 'hiddenInset'`（保留系统红绿灯）。
原因：Windows 上「自绘那三枚按钮」和「保留系统按钮」不能兼得 —— 系统按钮只能由
`titleBarOverlay` 提供，而它的样子改不了。代价是失去「悬停最大化按钮弹出贴靠布局」；
双击最大化、边缘拖拽缩放仍由 Electron/Chromium 提供。

改标题栏时记住两件事：

- 整条是 `-webkit-app-region: drag`，**每一枚按钮都必须显式 `no-drag`**。
  忘了标，点它会变成拖窗口 —— 而这在截图里完全看不出来。
- 最大化状态要**主动问一次**（`windowIsMaximized`），不能只订阅事件：
  「启动时窗口已经是最大化」这种情况永远收不到通知，图标会一直是 □。

`scripts/verify-titlebar.mjs` 守着这两条。

---

## 4. 验证脚本

终端类项目光靠类型检查远远不够。`scripts/` 下每个脚本都对应过至少一个真实 bug。

```bash
node scripts/verify-theme.mjs        # 界面主题：漏改检测、切换、三选、持久化、WCAG、静态守卫
node scripts/verify-titlebar.mjs     # 自绘标题栏：拖拽区、三枚按钮真的作用到窗口
node scripts/verify-container.mjs    # 容器终端：本机与 SSH 两条路，含远端零改动静态守卫
node scripts/verify-ui-polish.mjs    # 界面走查回归
node scripts/verify-layout.mjs       # 布局持久化与重启恢复
node scripts/verify-render.mjs       # 终端渲染（@xterm/headless，14 种场景）
node scripts/verify-ssh.mjs          # SSH 握手链路
# …以及传输、编辑器、拖拽、rz/sz 等
```

需要远端会话的脚本前置：`npm run build`，且已保存一个可连接的设备。
**这些脚本会对远端建临时文件并自己删掉，不装任何东西。**

### 跑之前先 `npm run build`

大部分脚本用 Playwright 的 `_electron` 启动 `out/` 下的**构建产物**，不是源码。
不 build 就是拿旧代码在验。

### 写新脚本时的几个坑（都真踩过）

- **别用 `includes` 认标记。** 终端**会回显敲进去的命令**，命令里往往就含那个标记。
  用 `hasOutputLine`（断言标记独占一行）。
- **macOS 上 Ctrl+点击 = 系统级右键。** Playwright 里做「多选」用 `modifiers: ['Meta']`，
  用 `Control` 会开出上下文菜单 —— 菜单背板（.menu-backdrop）随即拦截后续所有点击，
  表现为「莫名其妙的超时/点错行」。真实用户同理：Mac 上多选就是 Cmd，应用代码不用改。
- **过滤行用 `hasText` 会撞上后缀名。** `rowOf('a.txt')` 同时匹配 `a.txt.tar.gz`，
  打包/重命名这类「产物名字包含源名字」的场景里必然点错行。用
  `filter({ has: locator('.file-name:text-is("a.txt")') })` 精确匹配。
- **fixture 与结果校验走脚本自己的 ssh2 直连**（verify-archive.mjs），不读终端文本、
  不依赖面板时机；UI 只驱动被测路径本身。
- **认终端要统一口径。** 写用 Playwright 的 `:visible`、读却用 `display !== 'none'`，
  两者判定不同，读到的可能是**别的标签**的缓冲区 —— 曾经从登录 banner 的
  `172.18.0.1` 里正则抠出「1x172」当成 resize 生效了。
- **认标签别靠字面量。** 本地终端标签的标题是 `本地 · <目录>`（shell integration 上报 cwd 之前
  才是字面的「本地终端」）。只排除后者会把**本机**标签错认成宿主机标签。
- **断言后果之前先确认前因。** 例如「父会话断开 → 容器标签变 closed」，
  得先确认父会话**真的断了**；否则命令没送进去会伪装成功能坏了。
  但反过来也别用状态点轮询去确认 —— 自动重连很快，中转态会在两次轮询之间溜走，改用**事件流**。
- **改了真实配置就必须还原。** 验证脚本跑的是真实应用、读写的是真实
  `%APPDATA%/dox/`——在一次设备/指纹/布局之外，**设置项**也是共享状态。
  脚本里拨了一个开关测「关掉会怎样」，测完没拨回去，用户下次开应用功能就是关的，
  而且毫无线索可查（实测踩过：监控条「没出现」，查到最后是上一轮测试留下的
  `false`）。凡是会落盘的改动，脚本收尾一律恢复原状——与「远端临时文件自己删掉」
  是同一类卫生要求，只不过这份垃圾留在本机配置里。

---

## 5. 图标

`build/icon.png` 不是手绘的，由脚本生成：

```bash
node scripts/generate-icon.mjs             # 出 build/icon.png（512）
node scripts/generate-icon.mjs --preview   # 另出 shots/icon-sizes.png（16/32/64/128 原生并排）
```

改图标**一定要看 `--preview` 那张图**。这是个要缩到 16×16 待在任务栏上的东西，
边缘锯齿和笔画粗细只有在真实小尺寸下才看得出来（脚本用 3 倍超采样 + 块平均降采样做抗锯齿）。

设计：天蓝→草绿竖向渐变圆角方块 + 白色终端提示符。渐变用的是主题的同一套色相
（`--accent` 天蓝 / `--success` 草绿），所以图标和界面是一眼能对上的同一个人。
用渐变底而不是浅底：图标要同时待在浅色和深色任务栏上，浅底在浅色任务栏上会糊掉轮廓。

⚠ **`scripts/generate-icon.mjs` 里的 `CHEVRON` / `BAR` / `STROKE` / `RADIUS`
与 `src/renderer/src/components/Logo.vue` 里的 SVG 几何一一对应。改一边必须同时改另一边**，
否则「界面里那个标记」和「任务栏上那个图标」会长得不一样。这是跨文件的手工同步点，没有编译期约束。

> 计算标记包围盒时注意：`>` 是描边（圆头，四周外扩半个线宽），`_` 是硬边矩形（不外扩）。
> 外扩量一律加上去会算错，得出「已居中」的结论而实际偏左上。

---

## 6. 踩过的坑（环境相关）

### dev 模式下改了 preload 的 API 面要重启

electron-vite 的 HMR 只覆盖渲染层源码。给 `window.api` 加了新方法而 dev 实例没重启时，
运行中的窗口用的还是启动那一刻构建的 preload —— 渲染层热更新成新代码后一调新方法
就是 `window.api.xxx is not a function`，而且是从 xterm 的事件回调里炸出来，看着像
终端崩了。**改 preload/shared 的 API 面之后重启 dev**，别信热更新。

### npm 装完 node-pty 可能丢 spawn-helper 的执行位

症状：本地终端一开就报 `posix_spawnp failed`（`LocalPtyManager.spawn` → `UnixTerminal`）。
npm 从缓存解包时偶尔不给 `node_modules/node-pty/prebuilds/*/spawn-helper` 加执行位，
原生模块能加载、但 fork 时 posix_spawnp 以 EACCES 失败。修复：

```bash
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper
```

另外 `electron install.js` 没跑（安装脚本被禁）时 electron-vite 会报 `Electron uninstall`，
需要 `node node_modules/electron/install.js` 手动补二进制（国内设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。

### POSIX shell 没有通用的 integration 入口

bash 的 `--rcfile` 是 bash 专属：zsh 报 `no such option`、fish 不认。**别以为
「$SHELL + --rcfile」能通吃 POSIX** —— 那是「本地终端打开即死」的写法。
zsh 用 ZDOTDIR 整个换掉配置目录（换掉后 `~/.zshenv` / `~/.zprofile` / `~/.zshrc`
zsh 都不会再自动读，要在注入的同名文件里逐个补回源）；fish 用 `-C 'source ...'`。
新加一种 shell 支持时，先确认它的启动文件机制，再选注入点。

### Windows：`where docker` 会先给出一个 POSIX 脚本

Docker Desktop 在 `C:\Program Files\Docker\Docker\resources\bin\` 里，除了 `docker.exe`
还放了一个 1359 字节、**没有扩展名**的 POSIX shell 脚本，而 `where docker` 把它排在前面。
直接拿 `found[0]` 去 spawn，Windows 会以 `ERROR_BAD_EXE_FORMAT (193)` 失败。

`ContainerManager.resolveExecutable` 因此在 Windows 上优先挑 `.exe`（POSIX 下仍取第一个，
因为 execvp 认 shebang）。**别把这个「优化」删掉。**

### 远端 `stty size` 不等于宿主机

容器里 `stty size` 必须随窗口尺寸变化 —— 这是「容器里的 vim/top 能不能用」的判据。
不变化说明 `setWindow → SIGWINCH → 容器 resize` 这条链断了。

### 截 Electron 窗口：先声明 DPI 感知

用 PowerShell 截窗口时，`GetWindowRect` 给的是**逻辑坐标**而 `CopyFromScreen` 收**物理像素**，
缩放屏上会整体偏移一大截。开头必须有 `SetProcessDPIAware()`。

另外窗口被别的窗口挡住时，`SetForegroundWindow` 会被 Windows 拒绝（前台切换有权限限制），
这时要用 `PrintWindow(hwnd, hdc, 2)`（`PW_RENDERFULLCONTENT`，否则 Chromium 的合成层画出来是一片黑）。

---

## 7. 改动的推荐节奏

1. `npm run typecheck` —— 两套类型检查都得过
2. 改完跑一遍受影响的验证脚本（**先 `npm run build`**）
3. 界面/配色改动：两套主题各截一次图肉眼核对（`node scripts/shot-theme.mjs`）

验证脚本不是「跑着好看」的：它们是这个项目里唯一能发现**静默错误**
（显示的是假的、漏改了一处、通道挂到废弃连接上）的手段。加新功能时顺手加断言，
比事后补便宜得多。

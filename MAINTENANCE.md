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

### 3.1 远端「无感」的现行口径：agent 允许，但永远 opt-in

红线的本义（项目负责人原话）：**不要一连上就往远端装 agent 之类的东西**。
2026-09 业务升级后口径放宽为：**dox-agent 允许存在，但安装必须用户显式触发**
（侧栏「远程助手」面板里对**单台机器**点「安装到这台机器」）。以下依旧禁止：

- **静默安装**：任何「连上即装 / 检测即装 / 更新即装」的代码路径都不许出现，
  安装入口只有 `AgentManager.install` 一处，且只能由面板按钮触达
- **写系统目录 / 要 root / 开机自启**：agent 只落在 `~/.dox/dox-agent`，
  删除该目录即完全卸载，跑完不留其他任何东西
- **建容器（run/create/pull）、拷文件进容器（cp）**：守卫不变

容器功能的允许项不变：只读探测、`docker exec` 进已存在的容器、`docker logs`、
用户显式触发的生命周期操作（`CONTROL_VERBS` 白名单）。

这条由 `verify-container.mjs` 的阶段 5 静态守着（扫 `src/main/container/` 有没有出现
`docker run/cp/build/pull/create`，外加 CONTROL_VERBS 白名单检查）。
**看到那条守卫红了就去改代码，不要去改守卫。**

同类约束更新：容器内文件浏览**可以经 agent 的 nsenter 做**（v2 计划），
不可以在容器里塞第二个常驻进程。

### 3.2 容器标签不参与重连，也不进布局快照

容器会话单独一个 `ContainerManager`，不塞进 `SessionManager`。原因是：

- 塞进去，`disconnect()` 会掐断整条 SSH 连接、`sftp()` 会返回宿主机文件系统、
  `handleClosed()` 会把它拖进重连循环；
- 容器标签不进 `dox-layout.json` —— 父会话 id 重启即失效，存下来只会造出无法恢复的僵尸标签。

所以「容器标签不会自动重连」这件事来自**那段代码根本不存在**，不是靠 guard 拦的。

父 SSH 会话断开时，`ContainerManager.stopBySession()` **必须当场把 `closed` 状态发出去**。
只删表 + 关通道是不够的：通道随后的 `'close'` 事件走到 `handleClosed` 时已经查不到这条记录，
会直接 return —— 界面于是停在「已连接」，而终端其实早就死了。那是最糟的一种错：不报错，但显示的是假的。

**例外：用户关宿主终端标签 ≠ 父会话断开。** 还有容器 exec 通道骑在连接上时，
`SessionManager.disconnect()` 不掐连接，把会话转成「孤儿」保活（`shouldKeepAlive`
由 ContainerManager 的通道计数提供；1→0 时 `onParentDrained` 回调
`releaseOrphan` 才真正断开）。孤儿自己的 shell 是主动 end 的，它的 close 事件
由 `handleClosed` 的 orphan 分支按 kind==='shell' 吞掉 —— 没有这层区分，
转孤儿时 end shell 会立刻把刚保活的会话拆掉。网络掉线不算此列：连接一死
exec 通道全灭，消费者没了，连接跟着埋（drain → releaseOrphan 在
finalize 里同步完成，不会再重连）。

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
node scripts/verify-cwd-history.mjs  # SFTP 目录历史（前进/后退）+ 标签右键「换到最近目录」
node scripts/verify-local-explorer.mjs # 本地终端文件面板：新建/重命名/编辑保存/删除/复制/打包全链路落盘
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
- **测试容器 sshd 的真配置在 `/config/sshd/sshd_config`**（进程以 `-f` 指定），
  不是 `/etc/ssh/sshd_config` —— 改错文件折腾一轮。凡涉及转发的 e2e
  （verify-port-suggest / port-watch / socks）都要求该配置里
  `AllowTcpForwarding yes`；莫名全部「Channel open failure」先查它。
- **dox-sshd-test 现在是 privileged dind**（verify-container-watch 需要「远端有 docker」）：
  重建命令带 `--privileged`，里面 `apk add docker` 后 `dockerd --storage-driver=vfs`
  （**必须 vfs** —— overlayfs 套 overlayfs 挂载直接 invalid argument），
  镜像用 `docker save | docker exec -i … docker load` 离线灌进去。
  把 doxtest 加进 docker 组后**必须重启容器**，sshd 已开的会话不认新组。
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
  `172.18.0.1` 里正则抠出「1x172」当成 resize 生效了。同类：宿主机标签和容器
  标签**各有**一条 `.agent-stats` 状态条（隐藏标签的也在 DOM 里），断言一律
  用 `.agent-stats:visible`，裸 `.agent-stats` 会匹配到隐藏标签那条干等超时。
- **认标签别靠字面量。** 本地终端标签的标题是 `本地 · <目录>`（shell integration 上报 cwd 之前
  才是字面的「本地终端」）。只排除后者会把**本机**标签错认成宿主机标签。
- **断言后果之前先确认前因。** 例如「父会话断开 → 容器标签变 closed」，
  得先确认父会话**真的断了**；否则命令没送进去会伪装成功能坏了。
  但反过来也别用状态点轮询去确认 —— 自动重连很快，中转态会在两次轮询之间溜走，改用**事件流**。
- **「事件到了渲染层但 UI 没反应」先查载荷形状。** agent 的 NDJSON 事件行是
  `{event, data:{…}}` **嵌套**结构，而 `shared/api.ts` 的 `onAgentPorts` 契约是
  拍平的 `{event, listening, added, removed}` —— AgentManager 广播前必须拍平
  （踩过：直接转发原始行，渲染层 `data.listening` 永远 undefined，两条检测路径
  静默全灭，连兜底的 /proc 轮询都被「agent 路径已成功」挡住不启动）。排查套路：
  写个跳过 UI 的 IPC 级小脚本直连 `window.api`（connect → agentStatus → watchPorts
  → onAgentPorts 打印原始事件），先分清是主进程没发、preload 没转、还是组件没处理，
  再往下挖。
- **推送类验证先等「基线帧」再动夹具。** agent watch / /proc 轮询的首帧是全量基线，
  基线到达**之前**起的监听会被收进基线、永远不弹 —— 表现为偶发的「气泡没出现」。
  脚本里先订阅事件流、确认首帧到了再 start nc。同理 nc 经 exec 通道绑定可能错过
  1-2 个扫描周期，「秒推」断言的宽限要给到 ≥2 个周期。
- **改了真实配置就必须还原。** 验证脚本跑的是真实应用、读写的是真实
  `%APPDATA%/dox/`——在一次设备/指纹/布局之外，**设置项**也是共享状态。
  脚本里拨了一个开关测「关掉会怎样」，测完没拨回去，用户下次开应用功能就是关的，
  而且毫无线索可查（实测踩过：监控条「没出现」，查到最后是上一轮测试留下的
  `false`）。凡是会落盘的改动，脚本收尾一律恢复原状——与「远端临时文件自己删掉」
  是同一类卫生要求，只不过这份垃圾留在本机配置里。
- **任务/载荷对象里带函数字段 = IPC 序列化炸弹。** TransferManager 的容器传输
  给任务挂了 `_prepare/_finalize/_cleanupStage` 钩子函数，而 `list()`/`snapshot()`
  当初只剥 `_cancel` —— 函数过不了结构化克隆，广播与 invoke 返回值全线
  "Failed to serialize arguments"，handler 直接报错、界面队列卡死。内部字段
  一律 `_` 前缀 + `publicTask()` 按前缀剥，**不要**逐字段列清单（加新内部字段
  时必然漏）。排查套路：page 没崩但 evaluate 莫名其妙失败/handler 报错时，
  抓主进程 stderr（`app.process().stderr`）—— 这类错只在主进程日志里。
- **容器 shell 就绪前敲键盘 = 输入被丢。** 容器标签从「标签出现」到
  `docker exec` 通道就绪有 1-3s（dind 更慢），这期间 pane.sessionId 还是 null，
  敲进去的字符直接蒸发 —— 表现为「echo 不回显」，其实是命令压根没送进去。
  脚本先等 xterm-rows 里出现提示符（如 `/ #`）再 type。
- **模糊文本按钮会点错。** `button:has-text("保存")` 同时命中「保存」和
  「保存并连接」（后者开了个宿主机标签，「全程无宿主标签」的断言就这么挂的）。
  对话框按钮一律 `text-is` 精确匹配。
- **测试容器里 sshd 听的是 2222 不是 22**（verify-direct-container 数连接数
  踩过）：`netstat | grep ':22 '` 永远是 0，按实际端口过滤。另外 conn 计数
  只能相对比较（夹具自己的 ssh 连接也算一条），别断言绝对值。
- **Vue 的 `v-else` 绑的是紧邻的前一个 `v-if`，不是你以为的那个。**
  AgentPanel 里「已安装」行用 `v-else-if`，后面跟了个独立的
  `v-if="outdated"` 升级按钮，再后面的 `<template v-else>` 就绑到了升级按钮上 ——
  结果「已安装且不需升级」时安装按钮照样渲染（用户：装完了怎么还显示「安装到 xxx」）。
  条件分支一多就用嵌套 template 显式分组，别靠 v-else 链条的隐式绑定。
- **CodeMirror 的 `Mod-s` 在 macOS 上是 ⌘S。** Playwright 脚本按
  `Control+s` 在 Mac 上不会触发保存 —— 曾经表现为「脏标记不消失、但下一步
  重载出来的内容却是改过的」这种灵异组合（重载被 confirm 挡住/读的是编辑器
  残留内容，把「保存根本没发生」遮住了）。脚本按平台选键
  （`process.platform === 'darwin' ? 'Meta+s' : 'Control+s'`），
  验证「写回远端」要直接读远端内容，别读编辑器 DOM。
- **UI 验证脚本的选择器会随界面改版过期。** verify-ui-flows 的 `.add-btn`
  在侧栏改版后不复存在（改成 `button[title="添加设备"]`），超时才暴露。
  界面结构改动时顺手 grep 一遍 scripts/ 里的对应选择器。
- **SSH exec 通道里 `cmd &` 的后台进程会随通道关闭被一起收掉**
  （进程组同生共死；而且子进程继承 stdout 时通道还会吊着不关）。
  测试要在远端驻留的靶子进程（sleep/nc）用
  `setsid cmd </dev/null >/dev/null 2>&1 &`；容器里用 `docker exec -d` 没这个问题。
  **agent 的 exec 同理**：起后台驻留进程必须重定向 stdout/stderr
  （`while :; do :; done >/dev/null 2>&1 &`），否则管道不 EOF，exec 吊到超时。
- **xterm 的「一行」是一个 div，`textContent` 拼接时不补换行。**
  对整个 `.xterm-rows` 取 textContent 再 `split('\n')`，拿到的其实是一整坨
  （回显的命令和输出首尾相接）——「标记独占一行」这种断言永远是假的。
  逐行断言要逐元素取：`.xterm-rows > div` 各自 `textContent`。
- **嵌套 exec 链每一层都要 `-it`。** `docker exec A docker exec B sh`
  只给最外层加 `-it`，内层分不到 tty：提示符/行编辑全没，表现为
  「进去了但 echo 不回显」。`nestedChainArgv` 的 interactive 标志对每一跳生效。
- **Vue reactive 数组过不了 IPC 结构化克隆。** 嵌套链
  `tab.container.chain` 是 Proxy 包着的 reactive 数组，直接当 IPC 参数
  抛 "An object could not be cloned"—— 传参前 `[...chain]` 展开成普通数组。
  （与「载荷对象带函数字段」同类：凡是跨 IPC 的，先确认手里的是纯数据。）
- **busybox `ps` 默认只显示 comm，不带参数**（`ps w` 也一样）——
  `ps | grep 'sleep 300'` 永远匹配不到，活着也报 GONE。
  断言带参数的命令用 `ps -o pid,args`，或直接扫 `/proc/*/cmdline`。
- **TransferTask.fileName 取的是 localPath 的 basename** —— 下载任务的
  fileName 是本地存盘名（保存对话框选的那个），不是远端文件名。
  脚本按任务找下载项时用 `remotePath` 匹配，别用 fileName。
- **泛通道必须配白名单。** `agentCall(method, params)` 给渲染层开了
  「任意 agent 方法」的形，主进程 handler 必须校验 method ∈ 显式集合
  （src/main/ipc/index.ts 的 AGENT_CALL_ALLOW）—— 泛通道不等于泛权限，
  加新 agent 方法时记得同步白名单，否则调用方拿到的是「不在白名单」的错。
- **「目标解析」函数各有适用域，别互相复用。** TerminalPanel 的
  `forwardTarget()` 对本机容器**故意**返回 null（端口转发建议：网桥 IP
  藏在 VM 里，转了也到不了）—— 进程管理拿它当判据，本机容器就吃不到
  「进程管理」菜单（更阴的是菜单项 v-if 用了另一个更宽的 computed，
  菜单显示了点下去没反应）。新能力开闸前先想清楚：本机容器/本地终端
  到底该不该有，再有意识地选判据。
- **多页签面板的所有页都活在 DOM 里（v-show 不是 v-if）。** MonitorPanel
  三个页签各有 `.filter-row input` 和 `.row`，验证脚本不写
  `.page:visible` 收窄就会撞上 strict mode violation 或数错行。
  同理，断言某行存在要轮询等首帧（ps_list 两次采样 + 往返，固定
  sleep 是脆的）。
- **验证夹具要清上次的靶子进程。** 「过滤后只剩 sleep 300」这种计数断言，
  上一次跑挂留下的同名进程会让计数 +1 —— 夹具开头先 `pkill -f` 清场，
  只清文件不清进程是不够的。
- **/proc/[pid]/fd 的 readlink 可以阻塞到秒级。** 卡死的 NFS/FUSE 挂载点
  会让单个 readlink 挂住，全机 fd 扫描在真实机器上实测吃过 11.6s
  （sys 10s+）——「就几千个文件很快」的假设不成立。凡是全量扫 /proc
  的代码必须：先确定要找什么（inode 集合）、找到即早退、再设总时间
  预算（net.go 的 socketScanBudget = 800ms），超预算返回部分结果。
- **通道闭包别捕获「彼时的」意图表。** AgentManager.connect() 的 onData
  闭包曾捕获建连瞬间的 watches 条目 —— 通道若是 agentCall 先建的
  （彼时没有任何订阅），之后订阅的帧会全部静默丢弃（`if (w)` 永远 false）。
  派发时必须现查（`this.watches.get(key)`）。症状：UI 偶尔整页没数据，
  且和点击顺序有关。
- **大表格必须限制渲染行数。** 千级进程的宿主机上，进程表全量 v-for
  每 2s 重绘能把 Electron 渲染进程打到 80%+ —— 排序照全量排，只渲染
  前 300 行，尾部给「共 N 条」提示（MonitorPanel 的 *_RENDER_CAP）。

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

`pack:win` 同理：electron-builder 会自己去 GitHub 下 electron zip / nsis / winCodeSign，
国内直连会 600s 超时或 ETIMEDOUT，要两个镜像一起给：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run pack:win
```

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

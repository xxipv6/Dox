# Dox

跨平台 SSH 终端 + SFTP 文件管理器（Electron 形态，对标 electerm / Tabby）。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Electron 44 + electron-vite 6（beta，支持 Vite 8） |
| UI | Vue 3.5 + Pinia 4 |
| 终端 | @xterm/xterm 6 + fit / webgl / web-links addons |
| SSH/SFTP | ssh2 1.17（主进程持有连接） |
| 配置 | electron-store 11 + safeStorage 加密敏感字段 |
| 语言 | TypeScript 5.9（vue-tsc 尚未兼容 TS 7，待生态跟上后升级） |

全工程 ESM（`"type": "module"`）。

> **接手维护先看 [MAINTENANCE.md](MAINTENANCE.md)** —— 会话 id 路由、必须守住的约束
> （远端零改动、令牌层、容器标签不重连）、验证脚本怎么跑、以及一批踩过的环境坑。

## 常用命令

```bash
npm run dev          # 开发模式（HMR）
npm run typecheck    # tsc(主/preload) + vue-tsc(渲染层)
npm run build        # 产物输出到 out/
npm run preview      # 以生产产物启动
npm run pack:win     # electron-builder 打包（M5 配置）
```

## 验证工具（scripts/）

终端类项目光靠类型检查远远不够——下面这些是踩坑后补的**可自动复现**的验证手段，
每个都对应过至少一个真实 bug：

| 脚本 | 用途 |
|---|---|
| `verify-render.mjs` | 用 @xterm/headless 把 pty 输出渲染成屏幕并断言，覆盖 14 种场景（宽窄窗、溢出滚动、放大缩小、resize 重排、启动竞态、cmd/pwsh 两种 shell） |
| `screenshot-app.mjs` | Playwright 驱动真实 Electron 窗口截图（布局/渲染的人工核对） |
| `shot-theme.mjs` | 两套主题各截一张（含设置弹窗与展开后的侧栏），改配色时用来肉眼对比 |
| `verify-theme.mjs` | **漏改检测**：亮/深两套下遍历全 DOM 计算样式，断言没有任何一处还在用旧调色板（漏改一个色值在深色下看着正常、只有亮色才露黑，人工核对 270 处不现实）；另覆盖默认主题、一键切换与联动、三选、跨重启持久化、WCAG 对比度、静态守卫 |
| `verify-titlebar.mjs` | 自绘标题栏：拖拽区是不是 drag、按钮是不是 no-drag（忘了标的话点按钮会变成拖窗口，截图完全看不出来）、− □ ✕ 是否真的作用到窗口上 |
| `verify-layout.mjs` | 布局持久化：真实重启还原、未保存的临时连接恢复成占位标签、设置持久化 |
| `verify-ui-flows.mjs` | 走通「保存设备 → 删除设备 → SSH 连接（含主机指纹确认）」全流程，并捕获渲染进程报错 |
| `verify-ui-polish.mjs` | 界面走查回归：行尾按钮不白占宽度、面包屑单斜杠、活动标签可辨、三处弹窗 Esc 可关、按钮里没有 emoji、设备搜索（按名称/地址/登录名/端口四种关键词各验一次，并确认「无匹配」与「一台都没有」是两句不同的话） |
| `verify-ssh.mjs` | 直连测试 SSH 握手链路，区分「网络不通」与「认证失败」 |
| `verify-ssh-ui.mjs` | 真实 UI 里故意用错密码连一次，检查错误是否可见 |
| `verify-reconnect.mjs` | 断线重连与会话恢复：远端 `kill -9 $PPID` 端掉自己这条会话，验重连、状态提示与迟到事件 |
| `verify-container.mjs` | 容器终端：**本机**与 SSH 两条路都走一遍（只读探测 → 右键「进入」→ 容器内 shell）；用 `/.dockerenv` 与 `stty size` 反证「真的在容器里」且 resize 真的传进去了；末尾静态守着「不出现 docker run/cp/start 等」这条零改动约束 |
| `verify-container-logs.mjs` | 容器「查看日志」：起一个持续吐日志的容器 → 右键「查看日志」→ 日志标签 connected 且流不断；重复点不堆第二个标签；结束自删容器 |
| `verify-path-links.mjs` | 终端路径交互：`cd va<TAB>` 不带偏面板（补全回归）、正常 cd 跟随、cd 不存在目录不动、Ctrl+点击路径开编辑器 |
| `verify-context-menu.mjs` | SFTP 右键菜单：菜单项、选区规则、Esc 关闭、多选下载只弹一次目录框且每项都落地 |
| `verify-archive.mjs` | SFTP「打包」：archive.ts 命令构造/转义/命名纯函数单测 + 端到端（多选打包 → 面板出现包 → tar -tzf 校验成员 → 单项打包 → 撞名避让），fixtures/校验走脚本自己的 ssh2 直连，不读终端文本 |
| `verify-dnd.mjs` | 拖拽上传：用 CDP 发**真实**拖放（不是合成 DataTransfer），一路验到远端字节 |
| `verify-editor.mjs` | SFTP 双击 → 内置编辑器查看 / 编辑 / 保存回远端全链路 |
| `verify-transfer-progress.mjs` | 进度条真的在走（不是静止装饰）+ 传完自动从队列消失 |
| `verify-transfer-cancel.mjs` | 传输取消：状态真变、远端不留半截文件 |
| `verify-folder-cancel.mjs` | 文件夹传输的「全部取消」不再被新冒出来的任务顶上 |
| `verify-pwsh-integration.mjs` | 校验 PowerShell 的 OSC 7（cwd）/ OSC 133（退出码）/ git 分支上报 |
| `verify-posix-integration.mjs` | 校验 POSIX 侧的同一契约：zsh（ZDOTDIR 注入）/ bash（--rcfile）/ fish（-C），装了哪个测哪个 |
| `verify-posix-local-ui.mjs` | 端到端：真实应用里新建本地终端 → 敲 `cd` → 断言标签标题跟随 cwd（守着「zsh 打开即死」那个回归） |
| `verify-cmd-integration.mjs` | 校验 cmd 的 PROMPT 注入能否上报 cwd |
| `verify-cmd-startup.mjs` | 隔离实验：shell 启动画面是否干净（排查「终端莫名多出内容」） |

调试本地终端原始字节流：设 `DOX_DEBUG_PTY=1` 启动，日志写到
`%APPDATA%/dox/dox-pty-debug.log`（进/出/尺寸协商逐条记录）。

## 目录结构

```
src/
├── main/                 # 主进程：SSH 连接全部在这里
│   ├── index.ts          # 窗口与生命周期
│   ├── ssh/SessionManager.ts   # ssh2 连接池、shell 数据流、心跳保活
│   ├── store/configStore.ts    # 会话配置持久化（safeStorage 加密）
│   └── ipc/index.ts      # IPC 路由
├── preload/index.ts      # contextBridge → window.api
├── shared/               # 主/渲染进程共用的类型与 IPC 通道常量
└── renderer/src/
    ├── App.vue                 # 布局 + 标签栏
    ├── components/TerminalPanel.vue   # xterm 封装
    ├── components/SessionSidebar.vue  # 会话列表 + 快速连接
    └── stores/sessions.ts      # Pinia 会话状态
```

## 当前进度

- **M1 骨架 ✅** + **M2 SSH 终端 ✅**：密码/私钥登录、多标签、resize 同步、断线状态提示、会话保存（密码加密落盘）
- **M3 SFTP ✅**：文件列表（面包屑/排序/刷新）、新建文件夹、重命名、删除、上传（文件选择框 + 拖拽）、下载（保存对话框）、传输队列（并发 2、流式传输、进度条、取消、清除已完成）
- **M4 ✅**：
  - 终端 ↔ SFTP **双向目录联动**：终端里 `cd` 面板自动跟随（⇄ 开关），面板点 ⌨ 让终端 `cd` 到当前目录
  - 终端 **Ctrl+F 搜索**（增量高亮）、**选中即复制**、**右键粘贴**
  - 终端输出里的**绝对路径 Ctrl/Cmd+点击**：目录 → SFTP 面板跳过去，文件 → 内置编辑器打开（点击时才 sftpStat 落地，识别纯文本猜测，过期路径静默不点）
  - 文件夹**递归上传/下载**（入队时展开为文件级任务）、目录**递归删除**（符号链接不跟随）
  - SFTP 右键「**打包**」：多选/单选在远端当前目录就地 tar 成 `.tar.gz`（不下载，下载走单独入口），撞名自动 `-2`/`-3` 避让
  - **分屏**：标签栏 ◧/⬓ 向右/向下分屏，每 pane 一条独立 SSH 会话（Tab→Pane 二级模型），pane 聚焦/关闭
  - **主题设置**：侧栏 ⚙ 弹窗，终端配色预设 + 字体/连字/字号/本地 shell；设置存在主进程 electron-store（不是 localStorage，打包后那个源不落盘），改完实时生效
  - **本地 shell 跨平台**：Windows 列 cmd / PowerShell / pwsh / Git Bash / WSL；POSIX 按 `$SHELL` + PATH 探测 bash / zsh / fish —— 注入方式各不相同（bash 走 `--rcfile`、zsh 走 ZDOTDIR、fish 走 `-C`），不认识的 shell（csh/dash/…）降级为无 integration 的干净终端，cwd 有 trackInput 兜底
- **M5 ✅**：electron-builder 三平台配置（`electron-builder.yml`）、应用图标生成脚本（`node scripts/generate-icon.mjs`，纯 Node 手写 PNG）、`electron-updater` 自动更新接线（GitHub Releases 渠道，需在 yml 中替换 owner/repo）
  - **Windows nsis 已验证**：`npm run pack:win` → `dist/Dox Setup 0.1.0.exe`（108MB）+ `latest.yml`
  - macOS dmg / Linux AppImage+deb 配置就绪但尚未在对应平台实测；签名公证需证书（mac `identity: null` 暂跳过签名，Windows 未配置证书则不签名，用户会看到 SmartScreen 提示）
- **二期（全部完成 ✅）**：
  - **跳板机 ProxyJump ✅**：会话配置挂 `jumpHostId` 指向另一条已保存会话；主进程递归建立跳板链（`forwardOut` 打通 TCP 通道，等效 `ssh -J`），最多 3 层嵌套；跳板连接与目标会话同生共死；快速连接表单可选跳板，列表用 ⛓ 标识
  - **rz/sz（ZMODEM）✅**：终端数据流经 zmodem.js Sentry 拦截，识别发起序列自动接管会话；sz 弹目录选择框逐块落盘（重名加序号、防路径穿越），rz 弹文件选择框经主进程读入后发送（单文件限 256MB 内存模式）；会话期间屏蔽键盘输入
  - **快捷命令片段 ✅**：侧栏管理常用命令（名称 + 多行命令），▶ 一键注入当前终端执行（多行逐行发送），⤵ 仅粘贴待编辑；持久化于 dox-config
  - **端口转发面板 ✅**：侧栏面板管理规则——本地转发（-L：本机监听 + `forwardOut` 管道）与远程转发（-R：`forwardIn` + `tcp connection` 按端口分发）；规则绑定会话，会话断开自动停止；非当前会话规则置灰显示
  - **known_hosts 指纹确认 ✅**：独立指纹库（`dox-known-hosts`），首连弹窗「信任并保存 / 仅本次 / 拒绝」，指纹变更时红色警告并对比新旧指纹；`hostVerifier` 异步挂起等用户决策（readyTimeout 60s）；跳板链每一跳同样校验
- **界面重设计 ✅**：亮色「晴空」为默认、深色「冷夜」可切换，侧栏顶栏一键切 / 设置里三选（含跟随系统）
  - **令牌层**：颜色/圆角/间距/字号全部收进 `styles.css` 的 CSS 变量，组件里只允许 `var(--token)`。改版前是散在 15 个文件里的约 270 个字面量（只对应 28 个不同值），「换一套配色」在那时不是一件能做的事
  - **主色分「颜料档 / 文字档」**：`--accent`(#0ea5e9) 在白底上只有 2.77:1，当文字和图标都不合格，所以另有 `--accent-text`(#0369a1, 5.9:1)；状态色同理（`--success-text` / `--warning-text` / `--danger-text`）。深色下这些别名回基色 —— 令牌**契约**两套主题一致，只有取值分叉
  - **界面与终端联动**：`themeId` 支持 `'auto'` 哨兵（跟随界面主题），切白天/夜晚时已开着的终端实时重绘；终端配色仍可手动覆盖，原 5 套经典预设一个色值都没动
  - **三处自带主题系统的表面各自接上**：xterm（复用既有的 `term.options.theme` watch）、**CodeMirror**（`Compartment` 就地重配，切主题不丢撤销历史）、原生控件（`nativeTheme.themeSource` + `color-scheme`，否则 `<select>` 弹出层在浅色下是深色的）
  - **不闪主题**：`html`/`body` 不刷底色，底色归 `#app`；主题落定前露出的是主进程算好的 `BrowserWindow.backgroundColor`
  - 侧栏改成只有一种标题形状（可折叠分区），原先「工具」大标题下并排三个同级小标题，四行字视觉重量相近、分不出层级
  - **侧栏顶栏放设备过滤**：品牌搬到标题栏后那一行空了出来，与其重复一个「Dox」，不如放个搜索 —— 按名称 / 地址 / 登录名 / 端口四种关键词都能命中（只匹配名称的话，记得 IP 的人会觉得搜索是坏的）
  - **标签栏**：标签从「等高矩形 + 竖线分割」改成有间距的圆角块，活动标签靠抬升的面 + 顶部高亮线 + 投影三重信号；右侧分屏/SFTP 按钮也改成圆角块 —— 它们和标签混成同一排「格子」时，分不清哪个是可切换的、哪个是动作
- **自绘标题栏 ✅**：Windows / Linux 上 `frame: false`，最顶上那条由我们自己画 —— logo + Dox + − □ ✕，跟主题同色；macOS 保留系统红绿灯（`titleBarStyle: 'hiddenInset'`）。代价是失去「悬停最大化按钮弹出贴靠布局」，双击最大化与边缘拖拽缩放仍在
- **应用图标重做 ✅**：`scripts/generate-icon.mjs` 生成，天蓝→草绿竖向渐变 + 白色 `>_`，3 倍超采样抗锯齿；`--preview` 出 16/32/64/128 原生并排图供肉眼核对（缩到 16px 才是真正要过的那关）。侧栏顶栏的品牌已并到标题栏，同一处不再出现两遍「Dox」
- **容器终端 ✅**：侧栏列出 Docker / Podman 容器（运行中/暂停/已停止全量展示，已停止淡一档），右键「进入」即在新标签页里得到该容器的 shell；右键「查看日志」开一个 `docker logs -f --tail 200` 标签（守护进程读日志驱动，不依赖容器内有 shell，已停止的容器也能看 —— 「它刚才为什么挂了」正是高频场景）；右键还可**启动 / 停止 / 恢复 / 删除**容器（`CONTROL_VERBS` 白名单，停止与删除落手前有确认）
  - **两种目标**：SSH 设备（列那台机器上的）与**本机**（本地终端标签下列本机的，Docker Desktop / Podman Desktop 都行）。上层完全一样，只有承载方式不同
  - 远端走**父 SSH 连接**上的一条 `docker exec` 通道；本机走一个 node-pty 跑 `docker exec -it`。两者共用 `container-` 前缀，所以在渲染层「容器里的一个 shell」就是一回事，不需要第二套 API
  - **零改动红线（更新口径）**：不装 agent、不建文件、不留痕迹；生命周期操作是用户显式触发的 docker 子命令，跑完什么都不留下。守卫扫的是 `docker run/create/pull/build/cp`（`verify-container.mjs` 阶段 5）
  - **探测**：远端一次 `remoteExec` 往返同时完成「找运行时」和「列容器」（`/bin/sh -c` 包裹 + 补 PATH + 回传绝对路径，为的是绕开 sshd 的最小 PATH 与「登录 shell 可能是 fish/csh」）；本机用 `execFile` 依次试 docker / podman，ENOENT 就是「没装」——**不经 shell，参数即 argv，没有把容器名拼进命令串的注入面**
  - 「怎么问」两条路不同，「怎么理解回答」完全共用：解析、状态推导、健康推导、错误分类、shell 解析、降级重试都在 `runtime.ts` 的纯函数里，`CommandError`/`outputsOf` 也提到了传输之上
  - 探测结果用判别联合返回，每种状态各有界面：没装 docker / 没权限访问 socket / 守护进程没跑 / 没有运行中的容器（另有 N 个已停止）
  - 进入前先探一次 shell（`bash` → `sh`），**在开标签之前**就把「容器已停止 / exec 被拒 / distroless 没有 shell」区分开；结果按 (目标, 容器) 缓存
  - 容器会话独立成 `ContainerManager`，不塞进 `SessionManager` —— 否则 `disconnect()` 会掐断整条 SSH 连接、`sftp()` 会返回宿主机文件系统、`handleClosed()` 会把它拖进重连循环。于是「容器标签不重连」来自那段代码**根本不存在**
  - 容器标签不进布局快照（父会话 id 重启即失效，存下来只会造出无法恢复的僵尸标签）；父会话重连后容器标签保持「已断开」，再点一次复用同一个标签。本机会话不受 SSH 断线影响 —— 它的 parentSessionId 是哨兵值，与任何真实会话 id 都不相等
  - 限终端：不做容器内文件浏览（VS Code Dev Containers 那条路要往容器里塞一个 server，直接违反「远端无感」）

## 已知待办（代码内 TODO）

- 连接建立到 TerminalPanel 挂载之间存在毫秒级窗口，首屏 banner 有极小概率丢失（渲染侧缓冲解决）
- Linux 无 Secret Service 时 safeStorage 退化为 base64，产品层面需提示
- safeStorage 密文与系统钥匙串身份绑定：换机/重装/钥匙串重置后旧密码解不开，需重输一次（连接时会自动弹该设备的编辑框自愈）
- cwd 跟踪基于本地输入解析（远端无 OSC 7 时）：`cd -`、远程命令改目录（如脚本内 cd）会导致面板与终端不一致，点 ⟳ 或关跟随即可。`cd` 失败有 sftpStat 落地校验不会误跳；Tab 补全/方向键历史过的命令会拿前缀去远端补全，唯一匹配才跟随
- 符号链接文件/目录暂不参与递归传输与删除（按设计跳过，防跟链风险）

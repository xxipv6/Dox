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

> **Windows 版注意**：node-pty 是原生模块，`pack:win` 必须在 Windows 机器或 CI
> （windows runner）上构建，Mac 上出不了 win 包。Windows 客户端的两个平台
> 差异点已处理：拖文件进本地终端按 shell 种类选引号（cmd 双引号 / PowerShell
> 与 POSIX 单引号）；SFTP 下载落盘文件名过 sanitizeWinName（Linux 远端合法的
> `: * ? " < > |`、保留名 CON/AUX 等在 Windows 是非法文件名）。

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
| `verify-ui-polish.mjs` | 界面走查回归：行尾按钮不白占宽度、面包屑单斜杠、活动标签可辨、三处弹窗 Esc 可关、按钮里没有 emoji、设备搜索（按名称/地址/登录名/端口四种关键词各验一次，并确认「无匹配」与「一台都没有」是两句不同的话）、死 pane 复活覆盖层出现且能原地重连、closed 状态点是灰色不是红、中键关标签、容器展开箭头不悬停也可见 |
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
| `verify-chunk-batcher.mjs` | 终端输出批处理器：保序合并、超量/定时 flush、dispose 静默 |
| `verify-zmodem-prescan.mjs` | ZMODEM 触发序列预扫描（未命中绕过 Sentry 逐块复制）：纯输出零丢失、单块/跨块触发识别、retract 回退 |
| `verify-transfer-speed.mjs` | 传输吞吐冒烟：64MB 随机文件上传+下载双向 sha256 比对，顺带实测两个方向的 MB/s（需主机参数） |
| `verify-port-suggest.mjs` | 端口转发建议：横幅/容器 IP 解析纯函数单测 + 端到端（nc 真监听 → 横幅 → 气泡 → 转发 → 本机 nc -z 连通） |
| `verify-port-watch.mjs` | /proc 静默监听发现：/proc/net/tcp 解析单测 + 端到端（基线端口**不弹**、静默 nc 被差分发现、转发连通） |
| `verify-socks.mjs` | SOCKS5 代理：握手状态机单测（假 connectFn 驱动真 Socket）+ 端到端（UI 建规则 → 经代理 CONNECT 活端口通/死端口拒） |
| `verify-agent.mjs` | dox-agent v1：go test + 交叉编译 + 端到端（UI 安装 → version 校验 → serve 握手 → watch_ports 事件抓到静默监听） |
| `verify-agent-watch.mjs` | 转发建议接 agent 推送：端到端（预装 agent → 静默 nc → 气泡 **1.8s** 内出现（时序即路径证明，/proc 要 ~10s）→ 转发连通），跑前需 `node scripts/build-agent.mjs`（需主机参数） |
| `verify-container-watch.mjs` | 容器标签静默端口发现：dind 端到端（容器里静默 nc → docker exec /proc 差分弹气泡 → 转发目标 = 容器网桥 IP → 本机连通）。前置：dox-sshd-test 为 privileged + 内部 dockerd（vfs）+ inner 容器 |
| `verify-agent-keepalive.mjs` | agent 通道保活：杀掉应用的 sshd 会话 → 自动重连 → serve 通道按订阅意图自动重建 → 静默 nc 仍被秒推（2.8s）。跑前需 `node scripts/build-agent.mjs` |
| `verify-agent-stats.mjs` | watch_stats + 性能监控概览：go test（/proc/stat、meminfo、nvidia-smi CSV 解析）+ 端到端（预装 agent + **假 nvidia-smi** 罐头数据 → 概览页每核格子/内存条/GPU 全出、显卡全名显存正确、持续刷新）。跑前需 `node scripts/build-agent.mjs` |
| `verify-container-agent.mjs` | 容器内 agent（Dev Containers 式注入）：UI 点「安装到容器」→ 容器内静默 nc 秒推 + 性能监控概览出每核格子 → `docker restart` 后 45s 节流重试自动复活、推送恢复。前置：dind + inner 容器 |
| `verify-container-fs.mjs` | 容器文件管理（agent fs 协议）：UI 安装 → 面板列容器根目录 → 新建文件夹 → 上传文件+目录（字节校验）→ 编辑器写回 → 下载文件/递归目录 → 宿主机中转目录零残留 → **6MB 大文件直传（agent ≥0.4.0 分块流式）双向 sha256 校验** → 容器内打包（Go 标准库 tar.gz）+ 撞名避让 → 递归删除。前置：dind + inner 容器 |
| `verify-agent-exec.mjs` | agent v0.4.0 新协议（IPC 层）：exec 回显/退出码/超时守卫/缺二进制/空 argv 拒绝、agentCall 白名单拦截、fs_usage、procList（via=agent、含 pid 1）、procKill 拒 pid 1 + TERM 实战、宿主 statvfs 磁盘用量 |
| `verify-process-panel.mjs` | 性能监控·进程页（UI）：SSH 标签右键「性能监控」→ 进程页退化 ps 模式列表 + 退化标记；容器标签装助手后右键 → agent ps_list → 过滤 → 行内结束 → 确认 TERM → 容器里进程真实消失 |
| `verify-monitor.mjs` | 性能监控面板（agent v0.6.0，本机容器）：概览页每核 CPU 格子 + 内存条；网络页 nc 监听出现在连接表（带状态与进程名）；进程页点 PID 跳网络页且过滤预设；右键菜单不再有「进程管理」 |
| `verify-sentinel.mjs` | 端口哨兵 + 网络页→进程页跳转（dind）：装宿主助手 → 静默起 nc → 哨兵 toast 出现且反查出进程名+PID → 点击直达网络页（按端口过滤）→ 连接行点进程名跳进程页（PID chip 精确过滤）|
| `verify-local-container-agent.mjs` | 本机容器 agent（LOCAL 分支，全程无 SSH）：本机起 alpine → 侧栏进入 → UI 安装（本机 docker cp 直拷）→ exec 回显 → procList 含主进程 → 右键进程面板 → 文件面板列容器根目录 |
| `verify-agent-v050.mjs` | agent v0.5.0（全程本机容器）：fs_du 子项降序返回、续传协议位（重入 begin 报 existing_size、偏移补齐 commit 内容正确）、watch_stats top_procs 点名 CPU 燃烧器、本机容器性能监控概览（每核格子 + 谁在吃 CPU）、用量条点开 du 分解。跑前需 `node scripts/build-agent.mjs` |
| `verify-nested-container.mjs` | 嵌套容器（任意深度 docker exec 链）：进 dind → 侧栏列出内层 inner → 进入（标题带 `▸` 链、echo 真执行）→ 内层 daemon 未运行的友好归类 + 原始报错折叠「详细信息」→ 嵌套标签无 SFTP/进程管理入口。前置：dox-sshd-test 里有 inner |
| `verify-ai-usage.mjs` | AI 容量状态栏（真实接口）：UI 添加 Kimi 账号 → 标题栏挂件「Kimi xx%」→ 浮层 5h 窗/每周两行 → IPC 快照字段齐备。需要 `KIMI_TEST_KEY` 环境变量 |
| `verify-terminal-drop.mjs` | 拖文件进终端：本地终端提示「粘贴路径」；拖出浮层消失；虚拟文件（getPathForFile 空路径）被过滤不粘进终端 |
| `verify-compose.mjs` | compose 右键（dind 端到端）：SFTP 面板右键 docker-compose.yml 出三项 → **输出抽屉流式滚动**（结局前先滚字）→ up -d 服务真起 → restart → **取消挂起的 pull（状态「已取消」且零残留）** → down 容器真没了。前置：dox-sshd-test 装 docker-cli-compose |
| `verify-direct-container.mjs` | 直连容器（免宿主机标签）+ 容器标签独立存活：保存设备（不连接）→ 设备行展开箭头列出容器（后台传输会话，全程无宿主机终端标签）→ 点容器名直接进 → echo 可交互 → 服务器侧 TCP 连接数证明只有一条传输连接；再验孤儿保活：宿主标签里进的容器，关宿主标签后 echo 仍可交互、连接数不变，最后的容器标签关掉后连接才被回收 |
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
- **远程助手 dox-agent ✅**（红线 opt-in 新口径）：Go 静态二进制（~2MB，linux/amd64+arm64 交叉编译，`node scripts/build-agent.mjs`），侧栏「远程助手」面板**显式点安装**才推送（宿主机：uname 选架构 → SFTP 传 .tmp 再 mv → `~/.dox/dox-agent`，删目录即完全卸载；**容器：Dev Containers 同款注入** —— docker info 选架构（distroless 没有 uname）→ `docker cp` 进容器 `/tmp/dox-agent`（远端经宿主机 /tmp 中转，**本机容器直拷不过 SSH**），容器删除即消失、stop/start 不影响）。永不静默装/不写系统目录/不自启。**本机容器也支持**：目标父会话是 LOCAL 哨兵时 AgentManager 整链走本机 docker CLI（execFile argv 不经 shell），serve 通道由本机 `docker exec -i` 子进程承载（ChannelStream 适配层让握手/分发/挂死处理一套代码两条路通用）。传输复用 SSH exec 通道跑 NDJSON 协议（hello / watch_ports / watch_stats / fs_*（含分块 fs_read_chunk / fs_write_begin/chunk/commit/abort 与 fs_usage / fs_du）/ ps_list / ps_kill / exec / stop，容器态由 `docker exec -i` 承载），watch_ports 在目标本地算 /proc 差分、只推变化；**断线保活**：SSH 自动重连后主进程按订阅意图重建 serve 通道并重发 watch（断档期轮询顶班、agent 帧回来即切回）；容器 restart（SSH 没断、重连钩子管不到）由渲染层 45s 节流重试复活。**系统状态**（v0.2.0 起）：watch_stats 帧（/proc/stat 差分 + meminfo + nvidia-smi 存在才报、每 5 帧刷一次）是「性能监控」概览页的数据源，与端口推送共用通道、0.1.0 老 agent 自动降级为不显示
- **SOCKS5 一键代理 ✅**：端口转发面板新增「代理 -D」规则类型 —— 本机起 SOCKS5 服务（RFC 1928 仅 CONNECT 免认证，自研握手状态机），每个连接经 SSH forwardOut 从**远端网络出口**发出（ssh -D 等价）。浏览器/终端代理指向 `socks5://127.0.0.1:端口` 即全局走服务器网络；每条连接现取 client，断线重连后无需重建自动恢复
- **端口哨兵 ✅**（agent watch_ports 差分）：连接建立后**新出现**的监听端口弹黄色警告 toast，自动反查进程名+PID（net_conns，0.6.2 起毫秒级；老助手只显示端口号），点击直达性能监控网络页按端口过滤；已有服务不打扰（首帧即基线），20s 自动淡出；设置里可关。性能监控双向跳转闭环：进程页点 PID → 网络页看它的连接；网络页点进程名 → 进程页精确定位（独立 PID chip，不被子串匹配污染）→ 顺手结束任务
- **UX 打磨（三路走查后的一批）✅**：死 pane 原地复活（重连耗尽/对端关闭/本地 exit 不再是「只能关标签重找设备」，覆盖层一键重连；直连容器按 originSavedId 重建承载）；编辑器 mtime 冲突给「强制覆盖 / 放弃本地并重新加载」内联横幅（原来保存被拒 = 整个编辑器被错误视图换掉，工作无路可出）；保存错误不再卸载编辑器；文件面板导航失败回滚路径不留「新路径配旧列表」；`agentFsRelease` 只释放真持有过的通道；助手面板区分「查询失败」与「未安装」；直连容器入口箭头常显 + 侧栏容器行补齐状态点/右键菜单/刷新（与容器面板同套动作）；重复进同一容器聚焦已有标签；容器文件面板有容器名徽章；助手面板黑话文案压成一句人话 + 详情折叠；共享 Spinner 替换纯文本加载态、容器面板刷新不再闪空；标签状态点 closed 灰 / error 红（本地 exit 不再像「出事了」）、分屏取最差 pane；关标签落相邻标签并 refit；中键关标签 + 激活自动滚入视区；agent-stats 掉线变灰不消失；终端右键菜单钳位 + Esc；传输失败原因内联、done 恒满格；文件面板错误全部走面板内横幅
- **性能优化 ✅**：终端输出 4ms/64KB 批处理合并（三处管理器共用 `chunkBatcher`，刷屏时 IPC 消息降 1-2 个数量级）；ZMODEM Sentry 改触发序列预扫描（常规输出不再逐块做 3 次 O(n) 复制）；SFTP 传输并发 2→4 + 高水位调大（读 1MB / 写 4MB，读了 ssh2 源码确认串行点）；渲染产物开 oxc 压缩 + FileEditor（CodeMirror）懒加载，首包 2.38MB → 0.58MB；更新检查延后 45s 退出启动关键路径；连接 ready 后后台预热 sftp 通道
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
  - **嵌套容器 ✅**：容器标签的「容器」分区列的是**它里面**的容器（dind 套 dind 真实存在），没有就是干净的空态提示。进入走任意深度的 `docker exec` 链（`docker exec A docker exec B …`，每跳由外侧 runtime 的 runc exec 直接送 argv，**任何一层都不需要容器里有 shell**，distroless 也成立；每跳二进制按父链缓存解析）；标签标题带 `外层 ▸ 内层` 链。嵌套层不开放 agent 依赖面（SFTP/进程管理/转发建议/装助手）——嵌套网桥 IP 从宿主机摸不到、docker cp 链没有嵌套实现
- **直连容器 ✅**（Dev Containers 式，免宿主机标签）：设备行左侧箭头展开即列出那台机器的运行中容器，点容器名直接进 —— 全程不开宿主机终端标签，容器操作骑在一条后台**传输会话**上（无 shell 的 SSH 连接，VS Code 里那条看不见的宿主连接；只收已保存设备 id，凭证不出主进程）。传输会话按需建立、引用归零自动回收（侧栏展开与容器标签各算一份占用）
  - **容器标签独立存活**：从宿主终端标签里进的容器，关掉宿主标签不再跟着死 —— 主进程发现还有 exec 通道骑在连接上时，把会话留作「孤儿」继续保活，最后一个容器通道关闭才真正断开（`ContainerManager` 按父会话计数通道、1→0 时回调 `SessionManager.releaseOrphan`）
- **容器文件管理 ✅**（agent v0.3.0 fs 协议）：容器标签的 SFTP 按钮打开的是**容器内**文件面板 —— 浏览/新建/重命名/删除/双击编辑写回全部经容器里的 dox-agent（`fs_list/stat/read/write/mkdir/rename/delete`，编辑器写回带 mtime 乐观锁）；上传下载走两段接力（本机 ↔ SFTP ↔ 宿主机 /tmp 独立中转目录 ↔ docker cp ↔ 容器，逐任务中转免批次协调，跑完自动清；agent ≥0.4.0 时自动切换为分块流式直传，不碰宿主机中转）；**打包**由 agent 用 Go 标准库产 tar.gz（不依赖容器里有 tar，distroless 也能打，撞名自动 -2 避让）。容器文件操作在宿主机上零残留
  - **版本兼容 UX**：面板/文件面板发现容器里是老 agent（缺 fs 方法）时给「升级到 vX」按钮与指路文案，而不是把 `unknown method` 原文糊给用户；升级 = 覆盖安装 + 旧 serve 通道自动重启（老二进制还跑在内存里，不换通道等于没升），终端侧 agent_closed 后立即重试一次新通道
- **性能监控 ✅**（agent v0.6.0，任务管理器式）：终端右键「性能监控」（SSH 标签看宿主机、容器标签看容器——本机容器也支持，通道走本机 docker CLI；本地终端没有这项）—— 右侧面板三页签：**概览**（每核 CPU 一个格子、有几核就几格，填充高度=占用率、60/90% 变档变色，内存条 + 「谁在吃 CPU」点名）、**网络**（netstat 式连接表：协议/本地/远端/状态/PID/进程名，来自 agent `net_conns` 直读 /proc/net/{tcp,tcp6,udp,udp6} + inode→进程映射，超 500 行截断标记）、**进程**（过滤框 + PID/用户/CPU%/MEM%/命令可排序表格；结束进程两级走：确认 → SIGTERM，5 秒还没退出行内亮「强制结束」SIGKILL；点 PID 跳网络页看那进程在和谁说话）。激活页签 2s 一轮（页面不可见暂停）；数据通路三级：agent ≥0.4.0 → `ps_list/ps_kill`（直读 /proc，distroless 也能列，CPU 两次采样差分）；宿主无 agent → 退化 `ps -eo`（标「退化模式」）；容器没装 → 指路去装。`ps_kill` 信号白名单 TERM/KILL + 拒 pid<2 + 拒自杀。v0.6.0 起 watch_stats 帧带 `cpus[]` 每核占用（/proc/stat 单次通读差分）
- **容器传输直传 ✅**（agent v0.4.0）：容器上传/下载从「SFTP → 宿主机 /tmp 中转 → docker cp」两段接力换成 `fs_write_begin/chunk/commit`（上传）与 `fs_read_chunk`（下载）1MB 分块流式 —— 少一次宿主落盘、进度是真进度（逐块更新）、distroless 容器也能传；写端 tmp 文件带 `.dox-tmp-` 标记防误删真文件，commit 带 mtime 乐观锁，冲突/取消清 tmp。老 agent 自动落回接力路径
- **Compose 右键 ✅**：SFTP 面板里右键 `docker-compose.yml` / `compose.yaml` 直接 **up -d / restart / down**（down 前确认）—— 宿主机走 `/bin/sh` 自检测脚本（v2 插件优先、老式 docker-compose 自动降级），dind 容器里经宿主 runtime exec 进去跑；输出进**底部抽屉实时流式滚动**（拉镜像/建网络全程可见，多条运行 pill 切换），**随时可取消**（关通道/杀进程 ≈ Ctrl+C —— 看着不对就掐掉改 Dockerfile 再来），up 拉镜像给足 10 分钟超时
- **磁盘用量条 ✅**：文件面板底部显示当前目录所在文件系统的用量（已用/总共 + 百分比，>85% 转警示色）；宿主机走 OpenSSH 的 `statvfs@openssh.com` SFTP 扩展（不装任何东西），容器走 agent `fs_usage`（容器有自己的 mount namespace，宿主的 statvfs 看不到里面），都不支持就不显示
- **静默执行 ✅**（agent v0.4.0 `exec`）：快捷命令片段第三个动作 ⚡—— 不开终端，经 agent 跑完拿回退出码 + stdout/stderr（面板内结果块，可复制）；argv 按空白拆分**不经 shell**（没有注入面，distroless 没有 sh 也能跑；管道/重定向用不了，需要它们就用「发送到终端」），输出截断 64KB、超时默认 30s 上限 120s。目标是装了 v0.4.0 助手的机器/容器才可用
- **磁盘用量分解 ✅**（agent v0.5.0 `fs_du`）：点文件面板底部用量条展开「谁占的」—— 当前目录直接子项按子树大小降序的条形列表（遍历上限 50 万项 / 15s，超了如实标「结果不完整」；不跨设备、不跟符号链接）；老 agent 给升级指路而不是糊 `unknown method` 原文
- **断点续传 ✅**（agent v0.5.0）：传输 tmp 路径从随机改为确定性（`路径.dox-tmp-<sha1前4位>`），`fs_write_begin` 重入报 `existing_size` —— 失败留下的半截 tmp 下次从断点继续（**取消仍是放弃**：取消清 tmp，失败留 tmp）；tmp 比本地文件还长说明源已变，弃 tmp 重传；下载按本地已有长度续、本地比远端长则截断
- **拖到终端即传 ✅**：文件拖进终端面板 —— SSH/容器终端 = 上传到**当前目录**（cwd 来自 shell integration / cd 跟踪，浮层实时显示目标目录；嵌套容器提示暂不支持）；本地终端 = 粘贴引号包裹的路径（Finder 拖终端的经典手势）
- **AI 容量速览 ✅**：标题栏常驻 Kimi Code / DeepSeek / GLM 账号的**已用**配额（`名字 5h:0% 7d:74%` 口径，与平台后台一致；DeepSeek 显示余额），≥70% 转警示色、≥90% 转危险色；主进程每 5 分钟轮询 + 点开看明细（重置时间、MCP 次数、赠送余额）；账号在设置里管理（**备注名区分多个同平台账号**，标题栏显示备注名），Key 经系统钥匙串（safeStorage）加密落盘、不出主进程

## 已知待办（代码内 TODO）

- 连接建立到 TerminalPanel 挂载之间存在毫秒级窗口，首屏 banner 有极小概率丢失（渲染侧缓冲解决）
- Linux 无 Secret Service 时 safeStorage 退化为 base64，产品层面需提示
- safeStorage 密文与系统钥匙串身份绑定：换机/重装/钥匙串重置后旧密码解不开，需重输一次（连接时会自动弹该设备的编辑框自愈）
- cwd 跟踪基于本地输入解析（远端无 OSC 7 时）：`cd -`、远程命令改目录（如脚本内 cd）会导致面板与终端不一致，点 ⟳ 或关跟随即可。`cd` 失败有 sftpStat 落地校验不会误跳；Tab 补全/方向键历史过的命令会拿前缀去远端补全，唯一匹配才跟随
- 符号链接文件/目录暂不参与递归传输与删除（按设计跳过，防跟链风险）

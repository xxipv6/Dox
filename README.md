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
| `verify-ui-flows.mjs` | 走通「保存设备 → 删除设备 → SSH 连接（含主机指纹确认）」全流程，并捕获渲染进程报错 |
| `verify-ssh.mjs` | 直连测试 SSH 握手链路，区分「网络不通」与「认证失败」 |
| `verify-pwsh-integration.mjs` | 校验 PowerShell 的 OSC 7（cwd）/ OSC 133（退出码）/ git 分支上报 |
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
  - 文件夹**递归上传/下载**（入队时展开为文件级任务）、目录**递归删除**（符号链接不跟随）
  - **分屏**：标签栏 ◧/⬓ 向右/向下分屏，每 pane 一条独立 SSH 会话（Tab→Pane 二级模型），pane 聚焦/关闭
  - **主题设置**：侧栏 ⚙ 弹窗，5 套终端配色预设（Tokyo Night / One Dark / Solarized Dark / Monokai / 亮色）+ 字号调节，localStorage 持久化，实时生效
- **M5 ✅**：electron-builder 三平台配置（`electron-builder.yml`）、应用图标生成脚本（`node scripts/generate-icon.mjs`，纯 Node 手写 PNG）、`electron-updater` 自动更新接线（GitHub Releases 渠道，需在 yml 中替换 owner/repo）
  - **Windows nsis 已验证**：`npm run pack:win` → `dist/Dox Setup 0.1.0.exe`（108MB）+ `latest.yml`
  - macOS dmg / Linux AppImage+deb 配置就绪但尚未在对应平台实测；签名公证需证书（mac `identity: null` 暂跳过签名，Windows 未配置证书则不签名，用户会看到 SmartScreen 提示）
- **二期（全部完成 ✅）**：
  - **跳板机 ProxyJump ✅**：会话配置挂 `jumpHostId` 指向另一条已保存会话；主进程递归建立跳板链（`forwardOut` 打通 TCP 通道，等效 `ssh -J`），最多 3 层嵌套；跳板连接与目标会话同生共死；快速连接表单可选跳板，列表用 ⛓ 标识
  - **rz/sz（ZMODEM）✅**：终端数据流经 zmodem.js Sentry 拦截，识别发起序列自动接管会话；sz 弹目录选择框逐块落盘（重名加序号、防路径穿越），rz 弹文件选择框经主进程读入后发送（单文件限 256MB 内存模式）；会话期间屏蔽键盘输入
  - **快捷命令片段 ✅**：侧栏管理常用命令（名称 + 多行命令），▶ 一键注入当前终端执行（多行逐行发送），⤵ 仅粘贴待编辑；持久化于 dox-config
  - **端口转发面板 ✅**：侧栏面板管理规则——本地转发（-L：本机监听 + `forwardOut` 管道）与远程转发（-R：`forwardIn` + `tcp connection` 按端口分发）；规则绑定会话，会话断开自动停止；非当前会话规则置灰显示
  - **known_hosts 指纹确认 ✅**：独立指纹库（`dox-known-hosts`），首连弹窗「信任并保存 / 仅本次 / 拒绝」，指纹变更时红色警告并对比新旧指纹；`hostVerifier` 异步挂起等用户决策（readyTimeout 60s）；跳板链每一跳同样校验

## 已知待办（代码内 TODO）

- 连接建立到 TerminalPanel 挂载之间存在毫秒级窗口，首屏 banner 有极小概率丢失（渲染侧缓冲解决）
- Linux 无 Secret Service 时 safeStorage 退化为 base64，产品层面需提示
- cwd 跟踪基于本地输入解析：`cd` 失败、`cd -`、远程命令改目录（如脚本内 cd）会导致面板与终端不一致，点 ⟳ 或关跟随即可
- 符号链接文件/目录暂不参与递归传输与删除（按设计跳过，防跟链风险）

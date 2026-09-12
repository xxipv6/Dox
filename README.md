# Dox

跨平台 SSH 终端 + SFTP 文件管理器（Electron，对标 electerm / Tabby）。

![CI](https://github.com/xxipv6/Dox/actions/workflows/ci.yml/badge.svg)

## 功能

**终端**
- 密码 / 私钥登录、多标签、分屏（每 pane 一条独立会话）、resize 同步、断线重连与状态提示
- 跳板机 ProxyJump（等效 `ssh -J`，最多 3 层）、known_hosts 指纹确认（首连信任 / 变更告警）
- rz/sz（ZMODEM）、Ctrl+F 搜索、选中即复制、终端输出里的绝对路径 Ctrl/Cmd+点击直达面板或编辑器
- 本地 shell 全平台集成：Windows 列 cmd / PowerShell / pwsh / Git Bash / WSL，POSIX 探测 bash / zsh / fish，cwd 跟踪（OSC 7 / OSC 133 注入）
- 拖文件进终端：远端会话 = 上传到当前目录，本地终端 = 粘贴引号包裹的路径

**SFTP 文件管理**
- 浏览 / 新建 / 重命名 / 递归删除、面包屑、排序；内置编辑器（查看 / 编辑 / 保存回远端，mtime 乐观锁冲突提示）
- 传输队列：并发 4、流式、进度、取消；文件夹递归上传下载；拖拽上传；断点续传
- 右键「打包」：远端就地 tar.gz（不下载），撞名自动避让
- 目录磁盘用量条 + 「谁占的」du 分解

**容器（Docker / Podman）**
- 侧栏列出本机或 SSH 远端的容器，右键进入 shell / 查看日志 / 启动 / 停止 / 删除
- 直连容器：设备行展开即进，免宿主机终端标签；容器标签独立存活
- 嵌套容器：任意深度 `docker exec` 链（dind 套 dind），distroless 也进得去
- 容器文件管理：浏览 / 编辑 / 上传下载（分块直传）/ 打包，全程在宿主机零残留
- 零改动红线：不装东西、不建文件、不留痕迹；`docker run/create/pull/cp` 永不出现

**远程助手 dox-agent（opt-in，Go 静态二进制 ~2MB）**
- 显式点安装才推送（宿主机 SFTP / 容器 docker cp 注入），删目录即完全卸载，永不静默装
- 性能监控：概览（每核 CPU 格子 + 内存）、网络（netstat 式连接表）、进程（排序 / 过滤 / 结束任务）
- 端口哨兵：连接后新出现的监听端口弹提醒，反查进程名 + PID，一键建转发
- 静默执行：不开终端跑命令拿退出码与输出（argv 不经 shell）

**网络与代理**
- 端口转发面板：本地 -L / 远程 -R，规则绑定会话、断开自动停
- SOCKS5 一键代理（等效 `ssh -D`）：浏览器指向 `socks5://127.0.0.1:端口` 即走服务器网络出口

**效率与界面**
- 快捷命令片段：一键注入终端 / 仅粘贴 / 经 agent 静默执行
- 亮色「晴空」/ 深色「冷夜」/ 跟随系统，终端与编辑器主题联动实时切换
- 自绘标题栏（Windows / Linux）、设备搜索（名称 / 地址 / 登录名 / 端口）
- AI 容量速览：标题栏常驻 Kimi / DeepSeek / GLM 配额用量，Key 经系统钥匙串加密

## 下载与安装

[GitHub Releases](https://github.com/xxipv6/Dox/releases) 提供 Windows（NSIS 安装包）、macOS（dmg / zip，未签名）、Linux（AppImage / deb）。

> macOS 未签名：首次打开需在「系统设置 → 隐私与安全性」里放行。Windows 未签名会出 SmartScreen 提示，选「仍要运行」。

## 开发

```bash
npm install
npm run dev          # 开发模式（HMR）
npm run typecheck    # tsc(主/preload) + vue-tsc(渲染层)，提交前必过
npm run build        # 产物输出到 out/
npm run pack:win     # electron-builder 打包（另有 pack:mac / pack:linux）
```

国内环境：`npm install` 被拦时设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后手动 `node node_modules/electron/install.js`；`pack:*` 需要 `ELECTRON_MIRROR` + `ELECTRON_BUILDER_BINARIES_MIRROR` 两个镜像（详见 MAINTENANCE.md）。

> **接手维护先看 [MAINTENANCE.md](MAINTENANCE.md)** —— 会话 id 路由、必须守住的约束（远端零改动、令牌层、容器标签不重连）、验证脚本怎么跑、以及一批踩过的环境坑。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Electron 44 + electron-vite 6（Vite 8） |
| UI | Vue 3.5 + Pinia 4 |
| 终端 | @xterm/xterm 6 + fit / webgl / web-links addons |
| SSH/SFTP | ssh2 1.17（主进程持有连接） |
| 远程助手 | Go 1.25 静态二进制（linux/amd64 + arm64，NDJSON over SSH exec） |
| 配置 | electron-store 11 + safeStorage 加密敏感字段 |
| 语言 | TypeScript 5.9，全工程 ESM |

## 架构速览

```
src/
├── main/                  # 主进程：所有连接与凭证都在这里
│   ├── ssh/               #   ssh2 连接池、shell 数据流、心跳保活、ProxyJump
│   ├── sftp/              #   SFTP 通道与传输队列
│   ├── container/         #   容器探测/进入/日志/生命周期（ContainerManager 独立成模块）
│   ├── agent/             #   dox-agent 安装与 NDJSON 协议通道
│   ├── forward/           #   端口转发（-L/-R）与 SOCKS5
│   ├── local/             #   本地 shell（node-pty）与各 shell integration 注入
│   └── store/             #   electron-store + safeStorage
├── preload/index.ts       # contextBridge → window.api（渲染层唯一入口）
├── shared/                # 主/渲染共用的类型与 IPC 通道常量
└── renderer/src/          # Vue：App（布局/标签栏）+ components/ + stores/
agent/                     # dox-agent（Go）：fs_* / ps_* / watch_* / exec 协议
scripts/                   # 验证脚本（见下）与构建工具
```

会话 id 前缀决定管理器路由：`local-` 本地终端、`container-` 容器、无前缀 SSH —— 这是「容器标签不重连、不拿宿主机 SFTP」等行为的根（细节见 MAINTENANCE.md）。

## 测试与验证

终端类项目光靠类型检查远远不够。`scripts/` 下有 40+ 个**可自动复现**的验证脚本（Playwright 驱动真实 Electron 窗口 + ssh2 直连夹具），每个都对应过至少一个真实 bug：渲染断言、主题漏改检测、断线重连、传输双向 sha256、容器端到端、agent 协议、端口转发、SOCKS5、compose 右键……跑法与夹具搭建（dind 测试容器）见 [MAINTENANCE.md](MAINTENANCE.md)。

CI（GitHub Actions）：三平台（macOS / Windows / Linux）typecheck + build，agent 三平台 `go build/vet/test`；打 `v*` tag 自动打包三平台产物上传 artifacts。

## 已知限制

- 连接建立到 TerminalPanel 挂载之间有毫秒级窗口，首屏 banner 有极小概率丢失
- Linux 无 Secret Service 时 safeStorage 退化为 base64
- safeStorage 密文绑定系统钥匙串：换机 / 重装后旧密码需重输一次（连接时自动弹编辑框自愈）
- cwd 跟踪基于本地输入解析（远端无 OSC 7 时）：`cd -`、脚本内 cd 会导致面板与终端不一致，点 ⟳ 或关跟随即可
- 符号链接不参与递归传输与删除（按设计跳过，防跟链风险）

## License

MIT

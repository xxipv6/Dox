# Dox

Dox 是一个面向远程开发的桌面工作区：把 SSH 终端、SFTP 文件管理、容器、端口转发和主机监控放在同一个窗口里。它基于 Electron，支持 Windows、macOS 和 Linux。

[下载最新版本](https://github.com/xxipv6/Dox/releases/latest)

## 为什么用 Dox

- **一个远程工作区**：终端、目录、容器和转发绑定到同一台设备，切换标签即可继续工作。
- **远端操作少绕路**：文件夹传输使用 tar 整流，远端删除和复制优先使用服务器本地命令，减少高延迟链路上的往返。
- **本地与远端一致**：本地 shell 也有终端、文件面板、编辑器、打包和传输队列。
- **助手按需安装**：`dox-agent` 只有在用户明确点击安装时才推送到主机或容器，不静默改动远端环境。

## 核心功能

### 终端与工作区

- SSH 密码 / 私钥登录，多标签和分屏；支持 ProxyJump（最多三层）与 known_hosts 指纹确认。
- 平铺：一键把所有标签铺成一屏网格（看日志、改配置、盯进程同屏）；配合广播下发可一次输入同时打进多个会话。
- 断线重连、状态提示、终端搜索、选中复制，以及 Ctrl/Cmd 点击绝对路径直达文件面板或编辑器。
- 本地 shell：Windows 的 cmd、PowerShell、pwsh、Git Bash、WSL；macOS/Linux 的 bash、zsh、fish。
- 跟踪当前目录，恢复标签布局；拖入文件可上传到远端当前目录，或在本地终端粘贴已转义的路径。
- rz/sz（ZMODEM）文件传输。

### SFTP 与文件面板

- 浏览、新建、重命名、递归删除、排序、面包屑和目录历史。
- 内置查看 / 编辑器，保存时检查远端 mtime，避免覆盖他人修改。
- Ctrl/Cmd+A 全选、C/V 复制粘贴、F 按名过滤；远端同会话复制走 `cp -a`，不经本机中转。
- 传输队列支持并发 8、进度、取消、断点续传和拖拽上传；文件夹优先走 tar 整流，目标不支持 tar 时自动回退逐文件传输。
- 远端就地打包 tar.gz、目录磁盘用量和 du 分解；右键可在终端打开当前目录。

### Docker / Podman

- 查看本机或 SSH 远端容器，进入 shell、查看日志、启动、停止和删除。
- 容器标签独立于宿主机连接；支持嵌套 `docker exec`，也能进入 distroless 容器。
- 容器文件浏览、编辑、上传、下载和打包；传输在宿主机完成，不在容器留下临时文件。

### 远程助手与网络

- `dox-agent` 提供 CPU / 内存、网络连接、进程、监听端口和静默命令执行。
- 发现新监听端口时提醒，并可一键创建转发。
- 端口转发支持本地 `-L`、远程 `-R`，以及 SOCKS5（等效 `ssh -D`）。

### 效率与界面

- 快捷命令片段：注入终端、仅粘贴，或通过 agent 静默执行。
- CLI 伴侣：`dox .` 打开当前目录，`dox user@host` 直接连接设备；单实例转发避免重复启动。
- 晴空 / 冷夜 / 跟随系统三种主题，标题栏和终端主题同步切换。
- 标题栏常驻显示每个 AI 账号的 5 小时和 7 天额度；Key 使用系统钥匙串保护。

## 下载与安装

前往 [GitHub Releases](https://github.com/xxipv6/Dox/releases) 下载对应平台的安装包：

| 平台 | 产物 |
| --- | --- |
| Windows | NSIS 安装包 |
| macOS | `.dmg` / `.zip`（未签名） |
| Linux | AppImage / `.deb` |

Windows 未签名安装包可能触发 SmartScreen，选择“仍要运行”。macOS 首次打开时，在“系统设置 → 隐私与安全性”中允许打开。

### macOS 提示“文件已损坏，无法打开”

将 Dox 移到“应用程序”目录并退出应用后，在终端依次执行（路径按实际应用名称调整）：

```bash
sudo codesign --force --deep --sign - /Applications/Dox.app
sudo xattr -rd com.apple.quarantine /Applications/Dox.app
sudo codesign --force --deep --sign - /Applications/Dox.app
```

执行完成后重新打开 Dox。若应用仍在下载目录，请先拖到 `/Applications`，并把命令中的 `Dox.app` 改成实际文件名。

## 开发

```bash
npm install
npm run dev          # Electron 开发模式（HMR）
npm run typecheck    # 主进程、preload、渲染层类型检查
npm run build        # 构建到 out/
npm run pack:win     # 另有 pack:mac / pack:linux
```

国内网络安装 Electron 失败时，可设置：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

打包还需要 `ELECTRON_BUILDER_BINARIES_MIRROR`。维护约束、验证脚本和发布流程见 [MAINTENANCE.md](MAINTENANCE.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面框架 | Electron 44、electron-vite 6、Vite 8 |
| UI | Vue 3.5、Pinia 4 |
| 终端 | xterm 6（fit、search、web-links、webgl） |
| SSH / SFTP | ssh2 1.17 |
| 远程助手 | Go 1.25 静态二进制，NDJSON over SSH exec |
| 配置与凭证 | electron-store 11、safeStorage |
| 语言 | TypeScript 5.9、Go |

## 项目结构

```text
src/main/       主进程：SSH、SFTP、容器、agent、转发、本地 shell、配置
src/preload/    安全的 contextBridge API
src/shared/     主进程与渲染层共用类型和 IPC 常量
src/renderer/   Vue 界面、标签栏、终端、文件面板和设置
agent/          dox-agent Go 源码
scripts/        agent 构建工具与验证脚本
```

主进程持有所有 SSH 连接和凭证；渲染层只通过 preload API 访问这些能力。会话 id 前缀用于区分本地终端、容器终端和 SSH 会话。

## 已知限制

- macOS 构建目前未配置 Apple 开发者签名与公证。
- Linux 没有 Secret Service 时，safeStorage 会退化为 base64；换机后需要重新输入保存的密码。
- 远端没有 OSC 7 时，脚本内部 `cd` 可能无法被面板准确跟踪，可手动刷新目录。
- 符号链接在递归传输和删除时按链接本身处理，不跟随进入目标目录。

## License

MIT

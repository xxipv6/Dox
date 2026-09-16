; Dox 自定义 NSIS 钩子（electron-builder 默认拾取 buildResources 下的 installer.nsh，
; electron-builder.yml 里 nsis.include 显式指向本文件）。
;
; 修的问题：内置 uninstallOldVersion 只卸「本次安装模式」对应的注册表上下文 ——
; per-user 安装只查 HKCU。若旧版当年是 per-machine 装的（写在 HKLM），它会被
; 完整留下：两份 Dox 并存，任务栏固定图标 / 旧快捷方式启动的永远是旧版，
; 表现为「装了新版，界面与内置 agent 却还是老的，也没有升级按钮」。
;
; 三个时机/条件上的刻意选择（都推演过反面）：
; 1. 用 customInstall（安装段内、新文件与快捷方式就位之后）而不是 customInit
;    （.onInit）—— onInit 时删旧版，用户随后取消向导会白丢一份安装；
; 2. 不以 $installMode 预判要不要查 HKLM —— initMultiUser 在 onInit 按旧安装
;    自动选模式，但安装方式页允许用户临时改选，onInit 时的值不作数。
;    以「HKLM 条目此刻还在不在」为准：本次是 per-machine 时内置已卸过，
;    条目没了，这里自然空转；
; 3. --keep-shortcuts 必须传 —— 桌面/开始菜单的同名快捷方式刚被本次安装
;    重写成新版的，旧卸载器默认会顺手删掉它们。
;
; 约束：本文件在脚本顶部被 include，GetInQuotes / copyFile / readReg 等
; installUtil.nsh 里的宏不可用，只能用 NSIS 内置指令。

!macro customInstall
  ReadRegStr $R6 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $R6 != ""
    ; 同目录 = 新旧同根，旧文件已被本次覆盖安装，跳过（防把刚装的新文件删掉）
    ${andIf} $R6 != $INSTDIR
    ${if} ${FileExists} "$R6\${UNINSTALL_FILENAME}"
      DetailPrint "Removing previous per-machine installation: $R6"
      ; 卸载器会删掉自己所在目录，先拷出来再跑（与内置 uninstallOldVersion 同款）；
      ; --updated /KEEP_APP_DATA：保留 %APPDATA%/dox 里的配置与凭证
      InitPluginsDir
      CopyFiles /SILENT "$R6\${UNINSTALL_FILENAME}" "$PLUGINSDIR\dox-old-uninstaller.exe"
      ; per-machine 卸载器会自提权（用户会看到一次 UAC 框），提权后异步执行，
      ; ExecWait 的返回值不可靠 —— 以「HKLM 卸载条目是否消失」为准，最多试 3 次
      StrCpy $R5 0
      dox_old_uninstall_retry:
        IntOp $R5 $R5 + 1
        ExecWait '"$PLUGINSDIR\dox-old-uninstaller.exe" /S /KEEP_APP_DATA --updated --keep-shortcuts /allusers _?=$R6' $R7
        Sleep 1500
        ReadRegStr $R8 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
        ${if} $R8 != ""
        ${andIf} $R5 < 3
          Goto dox_old_uninstall_retry
        ${endif}
      ${if} $R8 != ""
        ; 失败不阻塞本次安装（新版已就位），只留日志 —— 残留的旧版由用户手动卸
        DetailPrint "Previous per-machine uninstall did not finish (continuing)"
      ${endif}
      Delete "$PLUGINSDIR\dox-old-uninstaller.exe"
    ${endif}
  ${endif}
!macroend

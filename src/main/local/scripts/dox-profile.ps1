# Dox shell integration —— 由 Dox 终端自动加载，请勿手动编辑
# 提供：彩色提示符 / git 分支 / cwd 上报（OSC 7）/ 命令边界与退出码（OSC 133）/ 历史补全
#
# 注意：PathInfo 没有 FullName 属性（取到 $null 会让 Join-Path 抛错并使 prompt 中断），
# 一律使用 ProviderPath。整个 prompt 用 try/catch 包住，任何异常都不能毁掉提示符。

$DoxEsc = [char]27

function global:Get-DoxGitBranch {
    try {
        $dir = Get-Location
        for ($i = 0; $i -lt 6 -and $null -ne $dir; $i++) {
            $gitDir = Join-Path $dir.ProviderPath '.git'
            if (Test-Path $gitDir) {
                $headPath = Join-Path $gitDir 'HEAD'
                if (Test-Path $headPath) {
                    $line = Get-Content $headPath -TotalCount 1 -ErrorAction SilentlyContinue
                    if ($line -match '^ref: refs/heads/(.+)$') { return $Matches[1] }
                    if ($line) { return $line.Substring(0, 7) }
                }
                return ''
            }
            $dir = $dir.Parent
        }
    } catch { }
    return ''
}

function global:prompt {
    # 必须最先捕获上一条命令的状态：任何赋值语句都会把 $? 重置为 true
    $ok = $?
    $lastExit = $LASTEXITCODE
    $esc = $DoxEsc
    try {
        $code = 0
        if (-not $ok) {
            if ($null -ne $lastExit -and $lastExit -ne 0) { $code = $lastExit }
            else { $code = 1 }
        }

        $cwd = (Get-Location).ProviderPath
        $uriPath = $cwd -replace '\\', '/'

        # 上一条命令结束（带退出码）→ 当前工作目录 → 新提示符开始
        [Console]::Write($esc + ']133;D;' + $code + $esc + '\')
        [Console]::Write($esc + ']7;file:///' + $uriPath + $esc + '\')
        [Console]::Write($esc + ']133;A' + $esc + '\')

        $display = $cwd
        if ($HOME -and $cwd.StartsWith($HOME)) { $display = '~' + $cwd.Substring($HOME.Length) }

        $blue = $esc + '[38;2;122;162;247m'
        $green = $esc + '[38;2;158;206;106m'
        $gray = $esc + '[38;2;86;95;137m'
        $red = $esc + '[38;2;247;118;142m'
        $reset = $esc + '[0m'

        $text = $blue + $display + $reset
        $branch = Get-DoxGitBranch
        if ($branch) { $text = $text + ' ' + $green + '(' + $branch + ')' + $reset }
        if ($code -ne 0) { $text = $text + ' ' + $red + '[' + $code + ']' + $reset }
        $text = $text + [char]10 + $gray + '>' + $reset + ' '

        # 末尾的 133;B 标记命令输入开始
        return $text + $esc + ']133;B' + $esc + '\'
    } catch {
        # 兜底：任何异常都退回一个能用的简单提示符
        return 'PS ' + (Get-Location).ProviderPath + '> '
    }
}

# 历史补全（PSReadLine 内联预测）
try {
    Import-Module PSReadLine -ErrorAction Stop
    Set-PSReadLineOption -PredictionSource History -ErrorAction SilentlyContinue
    Set-PSReadLineOption -PredictionViewStyle InlineView -ErrorAction SilentlyContinue
    Set-PSReadLineOption -HistorySearchCursorMovesToEnd -ErrorAction SilentlyContinue
    Set-PSReadLineOption -MaximumHistoryCount 10000 -ErrorAction SilentlyContinue
} catch { }

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

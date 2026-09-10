# Dox shell integration (zsh) —— 由 Dox 终端通过 ZDOTDIR 自动加载
# 提供：cwd 上报（OSC 7）/ 命令边界与退出码（OSC 133）
#
# zsh 没有 bash 的 --rcfile，Dox 把本文件写成 $ZDOTDIR/.zshrc 来注入，
# 所以要在这里手动补上用户自己的配置。

if [ -f "$HOME/.zshrc" ]; then
  . "$HOME/.zshrc"
fi

__dox_precmd() {
  local __dox_code=$?
  # 上一条命令结束（带退出码）
  printf '\033]133;D;%s\033\\' "$__dox_code"
  # 当前工作目录
  printf '\033]7;file://%s%s\033\\' "${HOST:-localhost}" "$PWD"
  # 新提示符开始
  printf '\033]133;A\033\\'
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __dox_precmd

# 提示符末尾标记命令输入开始（%{ %} 表示非打印序列）
PS1="${PS1}%{$(printf '\033]133;B\033\\')%}"

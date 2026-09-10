# Dox shell integration —— 由 Dox 终端自动加载
# 提供：cwd 上报（OSC 7）/ 命令边界与退出码（OSC 133）

if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

__dox_prompt_command() {
  local __dox_code=$?
  # 上一条命令结束（带退出码）
  printf '\033]133;D;%s\033\\' "$__dox_code"
  # 当前工作目录
  printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$PWD"
  # 新提示符开始
  printf '\033]133;A\033\\'
}

PROMPT_COMMAND="__dox_prompt_command; $PROMPT_COMMAND"

# 提示符末尾标记命令输入开始（\[ \] 表示非打印序列）
PS1="$PS1\[\e]133;B\e\\\]"

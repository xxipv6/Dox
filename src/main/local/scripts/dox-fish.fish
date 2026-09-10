# Dox shell integration (fish) —— 由 Dox 终端通过 `fish -C 'source ...'` 自动加载
# 提供：cwd 上报（OSC 7）/ 命令边界与退出码（OSC 133）
#
# fish 的启动文件（config.fish）先于 -C 执行，用户配置不受影响。

function __dox_fish_prompt --on-event fish_prompt
    # fish_prompt 事件触发时 $status 仍是上一条命令的退出码
    # 上一条命令结束（带退出码）
    printf '\033]133;D;%s\033\\' $status
    # 当前工作目录
    printf '\033]7;file://%s%s\033\\' (hostname) $PWD
    # 新提示符开始
    printf '\033]133;A\033\\'
end

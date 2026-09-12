//go:build unix

package main

import (
	"os"
	"syscall"
)

/*
 * 平台相关系统调用的 Unix 实现（Linux 是运行目标；macOS 是开发机，go test 要能编译）。
 * Windows 没有这些 syscall，对应实现在 sys_windows.go —— 只保证编译与单测可跑，
 * agent 二进制本身永远不会以 Windows 为目标。
 */

// statfsOf 取路径所在文件系统的块大小与块计数（fs_usage 用）
func statfsOf(path string) (bsize uint64, blocks, bfree, bavail uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, 0, 0, err
	}
	return uint64(st.Bsize), st.Blocks, st.Bfree, st.Bavail, nil
}

// devOf 取文件所在设备号（fs_du 不跨挂载点用）；取不到返回 ok=false
func devOf(info os.FileInfo) (dev uint64, ok bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Dev), true
}

// ps_kill 的信号白名单：TERM 先礼后兵，KILL 兜底。其余信号（STOP/CONT…）
// 对「结束任务」这个场景没有正当用途，不开口子。
var allowedSignals = map[int]bool{int(syscall.SIGTERM): true, int(syscall.SIGKILL): true}

func killProcess(pid, sig int) error {
	return syscall.Kill(pid, syscall.Signal(sig))
}

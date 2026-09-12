//go:build windows

package main

import (
	"errors"
	"os"
)

/*
 * Windows 桩：agent 只会跑在 Linux 上，这些实现存在的唯一意义是让
 * 「在 Windows 开发机上 go test」能编译通过（纯解析单测不碰这些路径）。
 */

func statfsOf(path string) (bsize uint64, blocks, bfree, bavail uint64, err error) {
	return 0, 0, 0, 0, errors.New("fs_usage 仅 Unix 可用")
}

func devOf(info os.FileInfo) (dev uint64, ok bool) {
	return 0, false
}

var allowedSignals = map[int]bool{15: true, 9: true} // SIGTERM / SIGKILL

func killProcess(pid, sig int) error {
	return errors.New("ps_kill 仅 Unix 可用")
}

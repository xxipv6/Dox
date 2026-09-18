//go:build !linux

// 非 Linux 平台的 fs_watch 桩：agent 只发布 Linux 构建，这里只为让
// 本机（macOS/Windows）的 go build / go test 能编过。
package main

import "errors"

type fsWatcher struct{}

func newFsWatcher(_ *safeEncoder) (*fsWatcher, error) {
	return nil, errors.New("fs_watch: 仅 Linux 支持")
}

func (w *fsWatcher) setDirs(_ []string) {}

func (w *fsWatcher) close() {}

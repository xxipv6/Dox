// 容器内打包：用 Go 标准库直接产出 .tar.gz。
//
// 宿主机的打包是远端跑 tar 命令；容器里不保证有 tar（distroless 连 shell
// 都没有）——但 agent 自己就在容器里，archive/tar + compress/gzip 都是
// 标准库，不依赖容器里的任何外部命令，什么镜像都能打。
package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func fsArchive(params json.RawMessage) (interface{}, error) {
	var p struct {
		Parent string   `json:"parent"`
		Names  []string `json:"names"`
		Target string   `json:"target"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Parent == "" || p.Target == "" || len(p.Names) == 0 {
		return nil, errors.New("fs_archive 需要 parent、names 与 target")
	}
	if !filepath.IsAbs(p.Parent) || !filepath.IsAbs(p.Target) {
		return nil, errors.New("parent 与 target 需要绝对路径")
	}
	parent := filepath.Clean(p.Parent)
	target := filepath.Clean(p.Target)
	if filepath.Dir(target) != parent {
		return nil, errors.New("target 必须落在 parent 目录里（与宿主机打包语义一致）")
	}
	for _, n := range p.Names {
		// 成员名只能是 parent 下的直接名：防 "../" 穿出 parent 把别处的文件打进包
		if n == "" || n == "." || n == ".." || strings.ContainsAny(n, "/\\") {
			return nil, errors.New("非法成员名: " + n)
		}
		if filepath.Join(parent, n) == target {
			return nil, errors.New("不能把包打进它自己")
		}
	}

	// O_EXCL：撞名避让是调用方的事，这里绝不覆盖已有文件
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)

	add := func(name string) error {
		root := filepath.Join(parent, name)
		return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			// 与宿主机的打包一致：符号链接不跟随（跳过，不打进包）
			if info.Mode()&os.ModeSymlink != 0 {
				return nil
			}
			hdr, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			// 包内路径 = 相对 parent 的名字（tar -C parent 的语义）
			rel, err := filepath.Rel(parent, path)
			if err != nil {
				return err
			}
			hdr.Name = filepath.ToSlash(rel)
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			if info.IsDir() || !info.Mode().IsRegular() {
				return nil
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return err
		})
	}
	for _, n := range p.Names {
		if err := add(n); err != nil {
			_ = tw.Close()
			_ = gz.Close()
			_ = out.Close()
			_ = os.Remove(target) // 打了一半的包不留
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		_ = out.Close()
		_ = os.Remove(target)
		return nil, err
	}
	if err := gz.Close(); err != nil {
		_ = out.Close()
		_ = os.Remove(target)
		return nil, err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(target)
		return nil, err
	}
	return map[string]string{"path": target}, nil
}

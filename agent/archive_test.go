package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestFsArchive(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa"), 0o644)
	_ = os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("bbb"), 0o644)
	_ = os.Symlink("a.txt", filepath.Join(dir, "link"))

	target := filepath.Join(dir, "out.tar.gz")
	res, err := fsArchive(json.RawMessage(`{"parent":` + jq(dir) + `,"names":["a.txt","sub"],"target":` + jq(target) + `}`))
	if err != nil {
		t.Fatalf("打包失败: %v", err)
	}
	if res.(map[string]string)["path"] != target {
		t.Errorf("返回路径错: %v", res)
	}

	// 读回成员清单
	f, _ := os.Open(target)
	defer f.Close()
	gz, _ := gzip.NewReader(f)
	tr := tar.NewReader(gz)
	members := map[string]string{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			data, _ := io.ReadAll(tr)
			members[hdr.Name] = string(data)
		} else {
			members[hdr.Name+"/"] = ""
		}
	}
	if members["a.txt"] != "aaa" {
		t.Errorf("a.txt 成员错: %v", members)
	}
	if members["sub/b.txt"] != "bbb" {
		t.Errorf("sub/b.txt 成员错: %v", members)
	}
	if _, ok := members["link"]; ok {
		t.Error("符号链接不该进包")
	}

	// 撞名：O_EXCL 拒绝覆盖
	_, err = fsArchive(json.RawMessage(`{"parent":` + jq(dir) + `,"names":["a.txt"],"target":` + jq(target) + `}`))
	if err == nil {
		t.Error("目标已存在时应拒绝（撞名避让是调用方的事）")
	}
	// 路径穿越
	_, err = fsArchive(json.RawMessage(`{"parent":` + jq(dir) + `,"names":["../etc"],"target":` + jq(filepath.Join(dir, "x.tar.gz")) + `}`))
	if err == nil {
		t.Error("成员名带 ../ 应被拒绝")
	}
	// target 不在 parent 里
	_, err = fsArchive(json.RawMessage(`{"parent":` + jq(dir) + `,"names":["a.txt"],"target":"/tmp/x.tar.gz"}`))
	if err == nil && filepath.Dir("/tmp/x.tar.gz") != dir {
		t.Error("target 不在 parent 里应被拒绝")
	}
}

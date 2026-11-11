package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFSMethodsUseSingleRegistry(t *testing.T) {
	methods := []string{
		"fs_list", "fs_stat", "fs_read", "fs_write", "fs_mkdir", "fs_rename", "fs_delete",
		"fs_archive", "fs_usage", "fs_du", "fs_search", "fs_read_chunk", "fs_write_begin",
		"fs_write_chunk", "fs_write_commit", "fs_write_abort",
	}
	for _, method := range methods {
		if !isFSMethod(method) {
			t.Errorf("异步分类遗漏 %s", method)
		}
		if _, ok, _ := dispatchFS(method, json.RawMessage(`{}`)); !ok {
			t.Errorf("dispatcher 遗漏 %s", method)
		}
	}
	if isFSMethod("fs_not_registered") {
		t.Error("未知 FS 方法不得进入异步分发")
	}

	// S3 是结构性契约：isFSMethod 不得再维护第二份 fs_* 字符串/switch 清单。
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "isFSMethod" {
			continue
		}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			switch n := node.(type) {
			case *ast.SwitchStmt:
				t.Error("isFSMethod 仍维护独立 switch，应直接查询统一 handler 注册表")
			case *ast.BasicLit:
				if strings.Contains(n.Value, "fs_") {
					t.Errorf("isFSMethod 仍包含平行方法名 %s", n.Value)
				}
			}
			return true
		})
		return
	}
	t.Fatal("未找到 isFSMethod")
}

func TestAgentVersion(t *testing.T) {
	if version != "0.9.6" {
		t.Fatalf("agent 版本应为 0.9.6，实际 %s", version)
	}
}

func buildAgentForTest(t *testing.T) string {
	t.Helper()
	name := "dox-agent"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(t.TempDir(), name)
	cmd := exec.Command("go", "build", "-o", path, ".")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("构建测试 agent 失败: %v\n%s", err, output)
	}
	return path
}

func TestUninstallRemovesCurrentExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 不允许删除运行中的 exe；Linux 成功路径使用跨编译二进制在 WSL 验证")
	}
	agent := buildAgentForTest(t)
	output, err := exec.Command(agent, "uninstall").CombinedOutput()
	if err != nil {
		t.Fatalf("uninstall 失败: %v\n%s", err, output)
	}
	if string(output) != "{\"ok\":true}\n" {
		t.Fatalf("uninstall 输出契约错误: %q", output)
	}
	if _, err := os.Stat(agent); !os.IsNotExist(err) {
		t.Fatalf("当前可执行文件未被删除: %v", err)
	}
}

func TestUninstallRejectsCallerPath(t *testing.T) {
	agent := buildAgentForTest(t)
	sentinel := filepath.Join(t.TempDir(), "must-not-delete")
	if err := os.WriteFile(sentinel, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(agent, "uninstall", sentinel).CombinedOutput()
	if err == nil {
		t.Fatalf("uninstall 不得接受调用方路径参数: %s", output)
	}
	if _, err := os.Stat(agent); err != nil {
		t.Fatalf("参数错误不应删除 agent: %v", err)
	}
	if got, err := os.ReadFile(sentinel); err != nil || string(got) != "keep" {
		t.Fatalf("调用方路径被修改: %q, %v", got, err)
	}
}

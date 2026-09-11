package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func call(t *testing.T, fn func(json.RawMessage) (interface{}, error), params string) interface{} {
	t.Helper()
	r, err := fn(json.RawMessage(params))
	if err != nil {
		t.Fatalf("调用失败: %v", err)
	}
	return r
}

func TestFsListAndStat(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644)
	_ = os.Mkdir(filepath.Join(dir, "sub"), 0o755)

	res := call(t, fsList, `{"path":`+jq(dir)+`}`).(map[string]interface{})
	ents := res["entries"].([]fsEntry)
	if len(ents) != 2 {
		t.Fatalf("列出 %d 项, 期望 2", len(ents))
	}
	var file, sub *fsEntry
	for i := range ents {
		if ents[i].Name == "a.txt" {
			file = &ents[i]
		}
		if ents[i].Name == "sub" {
			sub = &ents[i]
		}
	}
	if file == nil || file.IsDir || file.Size != 5 {
		t.Errorf("文件条目错: %+v", file)
	}
	if sub == nil || !sub.IsDir {
		t.Errorf("目录条目错: %+v", sub)
	}

	st := call(t, fsStat, `{"path":`+jq(filepath.Join(dir, "a.txt"))+`}`).(map[string]interface{})
	if st["is_dir"].(bool) || st["size"].(int64) != 5 {
		t.Errorf("stat 错: %+v", st)
	}
}

func TestFsReadTextBinaryAndDir(t *testing.T) {
	dir := t.TempDir()
	txt := filepath.Join(dir, "t.txt")
	_ = os.WriteFile(txt, []byte("你好 dox"), 0o644)
	res := call(t, fsRead, `{"path":`+jq(txt)+`}`).(map[string]interface{})
	data, _ := base64.StdEncoding.DecodeString(res["data"].(string))
	if string(data) != "你好 dox" {
		t.Errorf("读回内容错: %q", data)
	}
	if res["binary"].(bool) {
		t.Error("文本被误判为二进制")
	}

	bin := filepath.Join(dir, "b.bin")
	_ = os.WriteFile(bin, []byte{'P', 'K', 0, 1, 2}, 0o644)
	res = call(t, fsRead, `{"path":`+jq(bin)+`}`).(map[string]interface{})
	if !res["binary"].(bool) {
		t.Error("含 NUL 的文件没被识别为二进制")
	}

	if _, err := fsRead(json.RawMessage(`{"path":` + jq(dir) + `}`)); err == nil {
		t.Error("读目录应报错")
	}
}

func TestFsWriteAndOptimisticLock(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "w.txt")
	_ = os.WriteFile(p, []byte("old"), 0o644)
	info, _ := os.Stat(p)
	mtime := info.ModTime().Unix()

	payload := func(data string, expected *int64) string {
		s := `{"path":` + jq(p) + `,"data":"` + base64.StdEncoding.EncodeToString([]byte(data)) + `"`
		if expected != nil {
			s += `,"expected_mtime":` + strconv.FormatInt(*expected, 10)
		}
		return s + `}`
	}

	// mtime 匹配 → 写入成功
	res := call(t, fsWrite, payload("new-content", &mtime)).(map[string]interface{})
	if res["mtime"].(int64) == 0 {
		t.Error("没返回新 mtime")
	}
	data, _ := os.ReadFile(p)
	if string(data) != "new-content" {
		t.Errorf("写入内容错: %q", data)
	}
	// 不留临时文件
	if _, err := os.Stat(p + ".dox-tmp"); !os.IsNotExist(err) {
		t.Error("临时文件没清掉")
	}

	// mtime 不匹配（拿旧 mtime 再写）→ 拒绝
	stale := mtime - 100
	if _, err := fsWrite(json.RawMessage(payload("x", &stale))); err == nil ||
		!strings.Contains(err.Error(), "拒绝覆盖") {
		t.Errorf("过期 mtime 应拒绝覆盖, 实际: %v", err)
	}
}

func TestFsMkdirRenameDelete(t *testing.T) {
	dir := t.TempDir()
	deep := filepath.Join(dir, "a", "b", "c")
	call(t, fsMkdir, `{"path":`+jq(deep)+`}`)
	if info, err := os.Stat(deep); err != nil || !info.IsDir() {
		t.Fatal("MkdirAll 没建成")
	}

	src := filepath.Join(dir, "a")
	dst := filepath.Join(dir, "z")
	call(t, fsRename, `{"from":`+jq(src)+`,"to":`+jq(dst)+`}`)
	if _, err := os.Stat(dst); err != nil {
		t.Fatal("rename 没生效")
	}

	// 非递归删非空目录 → 报错
	if _, err := fsDelete(json.RawMessage(`{"path":` + jq(dst) + `}`)); err == nil {
		t.Error("非递归删非空目录应报错")
	}
	// 递归删
	call(t, fsDelete, `{"path":`+jq(dst)+`,"recursive":true}`)
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Error("递归删除没生效")
	}
}

func TestFsDeleteGuards(t *testing.T) {
	if _, err := fsDelete(json.RawMessage(`{"path":"/","recursive":true}`)); err == nil {
		t.Error("递归删 / 应被拒绝")
	}
	if _, err := fsDelete(json.RawMessage(`{"path":"/etc","recursive":true}`)); err == nil {
		t.Error("递归删单层近根路径应被拒绝")
	}
	if _, err := fsDelete(json.RawMessage(`{"path":"/proc/1/status"}`)); err == nil {
		t.Error("/proc 写操作应被拒绝")
	}
	if _, err := fsDelete(json.RawMessage(`{"path":"relative/path"}`)); err == nil {
		t.Error("相对路径应被拒绝")
	}
}

func jq(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

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

// ---- 分块流式读写与 fs_usage ----

func TestFsChunkedWriteReadRoundtrip(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "big.bin")
	// 两块写：一块正常 + 一块贴上限边界内的小尾巴
	begin := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]string)
	tmp := begin["tmp"]
	if !strings.Contains(tmp, doxTmpMarker) {
		t.Fatalf("tmp 名字没带标记: %s", tmp)
	}
	chunk1 := base64.StdEncoding.EncodeToString([]byte("hello-"))
	chunk2 := base64.StdEncoding.EncodeToString([]byte("chunked-world"))
	p1, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "offset": 0, "data": chunk1})
	if _, err := fsWriteChunk(p1); err != nil {
		t.Fatal(err)
	}
	p2, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "offset": 6, "data": chunk2})
	if _, err := fsWriteChunk(p2); err != nil {
		t.Fatal(err)
	}
	// commit 前目标文件不该存在
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("commit 前目标文件不应存在")
	}
	pc, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "path": target})
	if _, err := fsWriteCommit(pc); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "hello-chunked-world" {
		t.Fatalf("roundtrip 内容不符: %q", got)
	}

	// 分块读回
	pr, _ := json.Marshal(map[string]interface{}{"path": target, "offset": 6, "length": 7})
	r := call(t, fsReadChunk, string(pr)).(map[string]interface{})
	if base64DecodeString(t, r["data"].(string)) != "chunked" {
		t.Fatalf("chunk 读内容不符: %v", r)
	}
	if r["eof"].(bool) {
		t.Fatal("读到一半不该 eof")
	}
}

func TestFsChunkedGuards(t *testing.T) {
	// 伪造 tmp 路径（不带标记）必须被拒
	bad, _ := json.Marshal(map[string]interface{}{"tmp": "/etc/passwd", "offset": 0, "data": "eA=="})
	if _, err := fsWriteChunk(bad); err == nil {
		t.Fatal("无标记 tmp 必须拒绝")
	}
	ab, _ := json.Marshal(map[string]interface{}{"tmp": "/etc/passwd"})
	if _, err := fsWriteAbort(ab); err == nil {
		t.Fatal("abort 无标记 tmp 必须拒绝")
	}
	// 相对路径 begin 拒绝
	if _, err := fsWriteBegin(json.RawMessage(`{"path":"rel/a.txt"}`)); err == nil {
		t.Fatal("begin 相对路径必须拒绝")
	}
	// 超长块拒绝
	tooBig, _ := json.Marshal(map[string]interface{}{"path": "/tmp/x", "offset": 0, "length": fsChunkMaxLen + 1})
	if _, err := fsReadChunk(tooBig); err == nil {
		t.Fatal("超上限 length 必须拒绝")
	}
}

func TestFsChunkedCommitConflict(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "exists.txt")
	_ = os.WriteFile(target, []byte("old"), 0o644)
	info, _ := os.Stat(target)
	oldMtime := info.ModTime().Unix()

	begin := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]string)
	pc, _ := json.Marshal(map[string]interface{}{
		"tmp": begin["tmp"], "path": target, "expected_mtime": oldMtime - 100,
	})
	if _, err := fsWriteCommit(pc); err == nil || !strings.Contains(err.Error(), "已被") {
		t.Fatalf("mtime 不符必须拒绝覆盖: %v", err)
	}
	// 冲突拒绝后 tmp 应已清理（rename 前的拒绝分支）
	if _, err := os.Stat(begin["tmp"]); !os.IsNotExist(err) {
		t.Fatal("冲突拒绝后临时文件应不存在（或被留待 abort）")
	}
}

func TestFsUsage(t *testing.T) {
	dir := t.TempDir()
	r := call(t, fsUsage, `{"path":`+strconv.Quote(dir)+`}`).(map[string]interface{})
	if r["total"].(uint64) == 0 || r["avail"].(uint64) == 0 {
		t.Fatalf("statfs 返回异常: %+v", r)
	}
}

func base64DecodeString(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

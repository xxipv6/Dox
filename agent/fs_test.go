package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
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

func TestFsWriteConcurrentSameTargetPreservesWholeContentAndMode(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "concurrent.bin")
	if err := os.WriteFile(target, []byte("old"), 0o751); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	payloads := [][]byte{
		bytes.Repeat([]byte("A"), 1<<20),
		bytes.Repeat([]byte("B"), 1<<20),
	}
	params := make([]json.RawMessage, len(payloads))
	for i, payload := range payloads {
		params[i], _ = json.Marshal(map[string]string{
			"path": target,
			"data": base64.StdEncoding.EncodeToString(payload),
		})
	}

	for round := 0; round < 16; round++ {
		start := make(chan struct{})
		errs := make(chan error, len(params))
		for _, param := range params {
			go func() {
				<-start
				_, err := fsWrite(param)
				errs <- err
			}()
		}
		close(start)
		for range params {
			if err := <-errs; err != nil {
				t.Fatalf("第 %d 轮并发写失败: %v", round, err)
			}
		}
		got, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, payloads[0]) && !bytes.Equal(got, payloads[1]) {
			t.Fatalf("第 %d 轮最终文件混合了两次写入", round)
		}
	}
	after, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if after.Mode().Perm() != before.Mode().Perm() {
		t.Fatalf("写入后权限从 %v 变为 %v", before.Mode().Perm(), after.Mode().Perm())
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
	begin := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]interface{})
	tmp := begin["tmp"].(string)
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

	begin := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]interface{})
	pc, _ := json.Marshal(map[string]interface{}{
		"tmp": begin["tmp"].(string), "path": target, "expected_mtime": oldMtime - 100,
	})
	if _, err := fsWriteCommit(pc); err == nil || !strings.Contains(err.Error(), "已被") {
		t.Fatalf("mtime 不符必须拒绝覆盖: %v", err)
	}
	// 冲突拒绝后 tmp 应已清理（rename 前的拒绝分支）
	if _, err := os.Stat(begin["tmp"].(string)); !os.IsNotExist(err) {
		t.Fatal("冲突拒绝后临时文件应不存在（或被留待 abort）")
	}
}

func TestFsUsage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("statfs 仅 Unix 可用；Windows 上只保证编译（sys_windows.go 桩）")
	}
	dir := t.TempDir()
	r := call(t, fsUsage, `{"path":`+strconv.Quote(dir)+`}`).(map[string]interface{})
	if r["total"].(uint64) == 0 || r["avail"].(uint64) == 0 {
		t.Fatalf("statfs 返回异常: %+v", r)
	}
}

// 续传：同一目标路径两次 begin 拿到同一个 tmp，第二次报告已存在的半截大小
func TestFsWriteBeginResume(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "resume.bin")

	b1 := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]interface{})
	if b1["existing_size"].(int64) != 0 {
		t.Fatalf("首次 begin 不应有 existing_size: %v", b1)
	}
	tmp := b1["tmp"].(string)

	// 写半截（模拟传到一半断线）
	chunk := base64.StdEncoding.EncodeToString([]byte("partial-"))
	p, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "offset": 0, "data": chunk})
	if _, err := fsWriteChunk(p); err != nil {
		t.Fatal(err)
	}

	// 重传：同路径 begin → 同 tmp + existing_size = 半截大小
	b2 := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]interface{})
	if b2["tmp"].(string) != tmp {
		t.Fatalf("tmp 不确定，续传无从谈起: %s vs %s", b2["tmp"], tmp)
	}
	if b2["existing_size"].(int64) != 8 {
		t.Fatalf("existing_size 应为 8: %v", b2["existing_size"])
	}

	// 从断点续写剩余部分再 commit，内容应完整无缝
	rest := base64.StdEncoding.EncodeToString([]byte("content"))
	p2, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "offset": 8, "data": rest})
	if _, err := fsWriteChunk(p2); err != nil {
		t.Fatal(err)
	}
	pc, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "path": target})
	if _, err := fsWriteCommit(pc); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "partial-content" {
		t.Fatalf("续传结果不符: %q", got)
	}
}

func TestFsWriteCommitRejectsHoleAndResumesFromContinuousPrefix(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "hole.bin")
	begin := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]interface{})
	tmp := begin["tmp"].(string)

	// 后块先到，前块失败：文件长度已经完整，但 [0,5) 仍是空洞。
	later, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "offset": 5, "data": base64.StdEncoding.EncodeToString([]byte("world"))})
	if _, err := fsWriteChunk(later); err != nil {
		t.Fatal(err)
	}
	commit, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "path": target})
	if _, err := fsWriteCommit(commit); err == nil {
		t.Fatal("中间有空洞的临时文件不得提交")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("不完整的临时文件不得替换目标")
	}

	// 续传只能从连续确认前缀开始，而不是从物理文件长度开始。
	resumed := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]interface{})
	if got := resumed["existing_size"].(int64); got != 0 {
		t.Fatalf("前块缺失时连续前缀应为 0，实际 %d", got)
	}
	prefix, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("hello"))})
	if _, err := fsWriteChunk(prefix); err != nil {
		t.Fatal(err)
	}
	if _, err := fsWriteCommit(commit); err != nil {
		t.Fatalf("补齐前块后应能提交: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "helloworld" {
		t.Fatalf("续传提交内容错误: %q, err=%v", got, err)
	}
}

func TestFsWriteBeginRecoversCorruptOrLegacyChunkState(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "corrupt metadata", true: "legacy tmp"}[legacy], func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "recover.bin")
			begin := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]interface{})
			tmp := begin["tmp"].(string)
			chunk, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("stale"))})
			if _, err := fsWriteChunk(chunk); err != nil {
				t.Fatal(err)
			}
			if legacy {
				if err := os.Remove(fsChunkMetadataPath(tmp)); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(fsChunkMetadataPath(tmp), []byte(`{"ranges":`), 0o644); err != nil {
				t.Fatal(err)
			}

			resumed := call(t, fsWriteBegin, `{"path":`+strconv.Quote(target)+`}`).(map[string]interface{})
			if got := resumed["existing_size"].(int64); got != 0 {
				t.Fatalf("不可信状态必须从零重传，实际 %d", got)
			}
			fresh, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "offset": 0, "data": base64.StdEncoding.EncodeToString([]byte("fresh"))})
			if _, err := fsWriteChunk(fresh); err != nil {
				t.Fatal(err)
			}
			commit, _ := json.Marshal(map[string]interface{}{"tmp": tmp, "path": target})
			if _, err := fsWriteCommit(commit); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(target)
			if err != nil || string(got) != "fresh" {
				t.Fatalf("恢复后的内容错误: %q, err=%v", got, err)
			}
		})
	}
}

type failingReadAtFile struct {
	info os.FileInfo
	err  error
}

func (f failingReadAtFile) ReadAt(p []byte, _ int64) (int, error) {
	return copy(p, "partial"), f.err
}
func (f failingReadAtFile) Stat() (os.FileInfo, error) { return f.info, nil }
func (f failingReadAtFile) Close() error               { return nil }

func TestFsReadChunkReturnsNonEOFErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "read-error.bin")
	if err := os.WriteFile(path, []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	readErr := errors.New("injected disk read failure")
	originalOpen := openFSReadChunkFile
	openFSReadChunkFile = func(string) (fsReadChunkFile, error) {
		return failingReadAtFile{info: info, err: readErr}, nil
	}
	t.Cleanup(func() { openFSReadChunkFile = originalOpen })

	params, _ := json.Marshal(map[string]interface{}{"path": path, "offset": 0, "length": 7})
	result, err := fsReadChunk(params)
	if !errors.Is(err, readErr) {
		t.Fatalf("非 EOF ReadAt 错误必须返回给调用方，result=%v err=%v", result, err)
	}
}

func TestFsDu(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "big/sub"), 0o755)
	_ = os.MkdirAll(filepath.Join(dir, "small"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "big/sub/f.bin"), make([]byte, 4096), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "small/t.txt"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "loose.txt"), make([]byte, 100), 0o644)

	r := call(t, fsDu, `{"path":`+strconv.Quote(dir)+`}`).(map[string]interface{})
	ents := r["entries"].([]duEntry)
	if len(ents) != 3 {
		t.Fatalf("应列出 3 个直接子项: %+v", ents)
	}
	// 按大小降序：big（含子树 4096）在最前
	if ents[0].Name != "big" || !ents[0].IsDir || ents[0].Size < 4096 {
		t.Fatalf("top1 应为 big 目录: %+v", ents[0])
	}
	if r["total"].(int64) < 4096+100 {
		t.Fatalf("total 偏小: %v", r["total"])
	}
	if r["truncated"].(bool) {
		t.Fatal("小目录不应 truncated")
	}

	// 文件 / 相对路径必须拒绝
	if _, err := fsDu(json.RawMessage(`{"path":` + jq(filepath.Join(dir, "loose.txt")) + `}`)); err == nil {
		t.Fatal("对文件 fs_du 应报错")
	}
	if _, err := fsDu(json.RawMessage(`{"path":"rel"}`)); err == nil {
		t.Fatal("相对路径应拒绝")
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

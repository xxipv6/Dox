package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 造一棵夹具树：a.txt（大小写混合）、sub/b.txt、node_modules/x.js、bin.dat（含 \0）、long.txt（长行）
func makeSearchFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", "Hello world\nnothing\nsay HELLO again\n")
	write("sub/b.txt", "hello from b\n")
	write("node_modules/x.js", "hello from node_modules\n")
	write("bin.dat", "hello\x00binary\n")
	write("long.txt", strings.Repeat("x", 10*1024)+"hello"+strings.Repeat("y", 10*1024)+"\n")
	return root
}

func runSearch(t *testing.T, params map[string]interface{}) map[string]interface{} {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	r, err := fsSearch(raw)
	if err != nil {
		t.Fatalf("fsSearch 报错: %v", err)
	}
	m, ok := r.(map[string]interface{})
	if !ok {
		t.Fatalf("返回类型不对: %T", r)
	}
	return m
}

func searchPaths(m map[string]interface{}) []string {
	out := []string{}
	for _, x := range m["matches"].([]fsSearchMatch) {
		out = append(out, x.Path)
	}
	return out
}

func TestSearchBasicIgnoreCase(t *testing.T) {
	root := makeSearchFixture(t)
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "hello", "ignore_case": true,
	})
	paths := searchPaths(m)
	joined := strings.Join(paths, "|")
	if !strings.Contains(joined, "a.txt") || !strings.Contains(joined, "b.txt") {
		t.Fatalf("应命中 a.txt 和 sub/b.txt: %v", paths)
	}
	if strings.Contains(joined, "node_modules") {
		t.Fatalf("node_modules 必须被排除: %v", paths)
	}
	if strings.Contains(joined, "bin.dat") {
		t.Fatalf("二进制文件必须被跳过: %v", paths)
	}
	// a.txt 两处（Hello/HELLO）+ b.txt 一处 + long.txt 一处 = 4 条
	if got := len(m["matches"].([]fsSearchMatch)); got != 4 {
		t.Fatalf("匹配数应为 4，得 %d", got)
	}
	if m["truncated"].(bool) {
		t.Fatal("不应 truncated")
	}
}

func TestSearchCaseSensitive(t *testing.T) {
	root := makeSearchFixture(t)
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "Hello", "ignore_case": false,
	})
	if got := len(m["matches"].([]fsSearchMatch)); got != 1 {
		t.Fatalf("大小写敏感只应命中 a.txt 的 Hello 一处，得 %d", got)
	}
}

func TestSearchRegex(t *testing.T) {
	root := makeSearchFixture(t)
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "h.llo", "is_regex": true, "ignore_case": true,
	})
	if len(m["matches"].([]fsSearchMatch)) == 0 {
		t.Fatal("正则 h.llo 应有命中")
	}
}

func TestSearchInvalidRegex(t *testing.T) {
	root := makeSearchFixture(t)
	raw, _ := json.Marshal(map[string]interface{}{
		"dir": root, "pattern": "([", "is_regex": true,
	})
	if _, err := fsSearch(raw); err == nil {
		t.Fatal("无效正则必须报错")
	}
}

func TestSearchEmptyResultIsArray(t *testing.T) {
	root := makeSearchFixture(t)
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "绝不存在的关键词zzz", "ignore_case": true,
	})
	matches := m["matches"].([]fsSearchMatch)
	if matches == nil {
		t.Fatal("空结果必须返回 [] 不是 null")
	}
	if len(matches) != 0 {
		t.Fatalf("不应有命中: %v", matches)
	}
}

func TestSearchLineAndCol(t *testing.T) {
	root := makeSearchFixture(t)
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "HELLO", "ignore_case": false,
	})
	matches := m["matches"].([]fsSearchMatch)
	if len(matches) != 1 {
		t.Fatalf("应只命中一条: %v", matches)
	}
	if matches[0].Line != 3 {
		t.Fatalf("HELLO 在第 3 行，得 %d", matches[0].Line)
	}
	if matches[0].Col != 4 {
		t.Fatalf("HELLO 在「say 」之后（字节列 4），得 %d", matches[0].Col)
	}
}

func TestSearchLongLinePreviewTruncated(t *testing.T) {
	root := makeSearchFixture(t)
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "hello", "ignore_case": true,
	})
	for _, x := range m["matches"].([]fsSearchMatch) {
		if strings.HasSuffix(x.Path, "long.txt") {
			if len([]rune(x.Text)) > fsSearchMaxLinePreview {
				t.Fatalf("长行预览必须截到 %d rune，得 %d", fsSearchMaxLinePreview, len([]rune(x.Text)))
			}
			return
		}
	}
	t.Fatal("long.txt 应命中")
}

func TestSearchMaxResultsTruncates(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 30; i++ {
		p := filepath.Join(root, string(rune('a'+i%26))+string(rune('a'+i/26))+".txt")
		if err := os.WriteFile(p, []byte("hit\nhit\nhit\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "hit", "ignore_case": true, "max_results": 10,
	})
	if !m["truncated"].(bool) {
		t.Fatal("撞 max_results 必须 truncated")
	}
	if got := len(m["matches"].([]fsSearchMatch)); got > 10 {
		t.Fatalf("结果不得超上限 10，得 %d", got)
	}
}

func TestSearchSymlinkNoLoop(t *testing.T) {
	root := makeSearchFixture(t)
	// 回环 symlink：sub/back -> 根。WalkDir 不跟 symlink，必须正常结束
	if err := os.Symlink(root, filepath.Join(root, "sub", "back")); err != nil {
		t.Skip("本机不支持 symlink")
	}
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "hello", "ignore_case": true,
	})
	if len(m["matches"].([]fsSearchMatch)) == 0 {
		t.Fatal("symlink 在场也应正常命中")
	}
}

func TestSearchRejectsRelativeAndFile(t *testing.T) {
	if _, err := fsSearch(json.RawMessage(`{"dir":"relative/path","pattern":"x"}`)); err == nil {
		t.Fatal("相对路径必须报错")
	}
	root := makeSearchFixture(t)
	raw, _ := json.Marshal(map[string]interface{}{
		"dir": filepath.Join(root, "a.txt"), "pattern": "hello",
	})
	if _, err := fsSearch(raw); err == nil {
		t.Fatal("目标是文件必须报错")
	}
	if _, err := fsSearch(json.RawMessage(`{"dir":"/","pattern":"a\nb"}`)); err == nil {
		t.Fatal("pattern 含换行必须报错")
	}
}

func TestSearchTinyBudgetTruncates(t *testing.T) {
	// 零命中 + 1ms 预算：预算由 context 兜底在 WalkDir/worker 上（hitLimit 只在
	// 命中时被调，零命中整程没人看表 —— 这条测试就是防那个回归的）。
	// 200 个文件的 open/read 必然超过 1ms，truncated 必须如实置位。
	root := t.TempDir()
	for i := 0; i < 200; i++ {
		p := filepath.Join(root, strings.Repeat("f", 8)+string(rune('a'+i%26))+string(rune('a'+(i/26)%26))+".txt")
		if err := os.WriteFile(p, []byte(strings.Repeat("z\n", 200)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := runSearch(t, map[string]interface{}{
		"dir": root, "pattern": "不存在", "ignore_case": true, "max_elapsed_ms": 1,
	})
	if m["truncated"] != true {
		t.Fatalf("预算到期必须报 truncated=true，得到 %v", m["truncated"])
	}
}

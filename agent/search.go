package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

/*
 * fs_search：目录内全文搜索。
 *
 * 设计目标是对标 ripgrep 那一档的速度：并发遍历 + Go regexp（RE2 引擎，
 * 与 ripgrep 的正则引擎同宗，线性时间无回溯）。工程细节上 rg 还有内存映射
 * 和 SIMD 预筛，但「秒级搜完一个项目」两者都够。
 *
 * 口径与 fs_du 相同：内部硬预算 + 结果上限 + truncated 标志。agent 协议是
 * 一问一答，没有协议级取消 —— 用户连击改关键词时，旧搜索浪费的是一次有界
 * 的 CPU 扫描（主进程侧按 runId 丢弃迟到响应），不污染任何状态。
 *
 * 一期不做 .gitignore：正确的 gitignore 语义（嵌套、双层星号、否定、逐级
 * 覆盖）是一个完整库，stdlib 没有；内置排除 .git/.hg/.svn/node_modules
 * 覆盖 90% 痛点，且与主进程 rg/grep/node 三引擎的排除清单完全一致。
 */

const (
	fsSearchDefaultMaxResults = 2000
	fsSearchMaxResultsCap     = 10000
	fsSearchDefaultBudgetMs   = 8000
	fsSearchMaxBudgetMs       = 15000
	fsSearchMaxFileSize       = 32 << 20 // 32MB
	fsSearchMaxLinePreview    = 500      // rune
	fsSearchScannerBuf        = 1 << 20  // 单行缓冲上限（超长行 Scanner 直接停，当不可搜处理）
)

var fsSearchExcludeDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true, "node_modules": true,
}

type fsSearchMatch struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	// 字节列，不是字符列（多字节文本下对不上）。一期只用于展示，
	// 编辑器跳转只消费 line —— 别拿它去定位光标。
	Col  int    `json:"col"`
	Text string `json:"text"`
}

func fsSearch(params json.RawMessage) (interface{}, error) {
	var p struct {
		Dir          string `json:"dir"`
		Pattern      string `json:"pattern"`
		IsRegex      bool   `json:"is_regex"`
		IgnoreCase   bool   `json:"ignore_case"`
		MaxResults   int    `json:"max_results"`
		MaxElapsedMs int    `json:"max_elapsed_ms"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Dir == "" || !filepath.IsAbs(p.Dir) {
		return nil, errors.New("fs_search 需要绝对路径 dir")
	}
	if p.Pattern == "" {
		return nil, errors.New("fs_search 需要 pattern")
	}
	if strings.ContainsAny(p.Pattern, "\r\n\x00") {
		return nil, errors.New("fs_search 的 pattern 不能含换行")
	}
	info, err := os.Stat(p.Dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("fs_search 的目标是目录")
	}
	maxResults := p.MaxResults
	if maxResults <= 0 {
		maxResults = fsSearchDefaultMaxResults
	}
	if maxResults > fsSearchMaxResultsCap {
		maxResults = fsSearchMaxResultsCap
	}
	budget := time.Duration(p.MaxElapsedMs) * time.Millisecond
	if budget <= 0 {
		budget = fsSearchDefaultBudgetMs * time.Millisecond
	}
	if budget > fsSearchMaxBudgetMs*time.Millisecond {
		budget = fsSearchMaxBudgetMs * time.Millisecond
	}

	// 匹配器：纯文本 strings.Contains（ignore_case 双 ToLower）；正则 RE2（ignore_case 拼 (?i)）
	var re *regexp.Regexp
	needle := p.Pattern
	if p.IsRegex {
		pat := p.Pattern
		if p.IgnoreCase {
			pat = "(?i)" + pat
		}
		re, err = regexp.Compile(pat)
		if err != nil {
			return nil, fmt.Errorf("fs_search 正则无效：%v", err)
		}
	} else if p.IgnoreCase {
		needle = strings.ToLower(needle)
	}
	matchLine := func(line string) int {
		if re != nil {
			loc := re.FindStringIndex(line)
			if loc == nil {
				return -1
			}
			return loc[0]
		}
		hay := line
		if p.IgnoreCase {
			hay = strings.ToLower(hay)
		}
		return strings.Index(hay, needle)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// 时间预算必须兜在「产生迭代的地方」（WalkDir/worker 都查 ctx）：
	// hitLimit 只在即将追加命中时被调，零命中的搜索整程没人看表 ——
	// 不存在的关键词在大目录上会把整棵树扫到底（实测 3000 文件/1ms 预算
	// 跑了 37ms 还报完整），而 agent 调用没有外部超时能拦住它。
	ctx, stop := context.WithTimeout(ctx, budget)
	defer stop()
	started := time.Now()

	files := make(chan string, 64)
	var matches []fsSearchMatch
	var mu sync.Mutex
	filesSearched := 0
	truncated := false

	// 撞线（结果上限/时间预算）→ truncated + 取消全局。调用时必须持有 mu。
	hitLimit := func() bool {
		if len(matches) >= maxResults || time.Since(started) > budget {
			truncated = true
			cancel()
			return true
		}
		return false
	}

	// 遍历生产者：WalkDir 不跟 symlink，无环
	go func() {
		defer close(files)
		_ = filepath.WalkDir(p.Dir, func(path string, d os.DirEntry, err error) error {
			if ctx.Err() != nil {
				return context.Canceled
			}
			if err != nil {
				return nil // 权限/消失：跳过
			}
			if d.IsDir() {
				if path != p.Dir && fsSearchExcludeDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			fi, err := d.Info()
			if err != nil || !fi.Mode().IsRegular() || fi.Size() > fsSearchMaxFileSize {
				return nil
			}
			select {
			case files <- path:
			case <-ctx.Done():
				return context.Canceled
			}
			return nil
		})
	}()

	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	if workers < 1 {
		workers = 1
	}
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range files {
				if ctx.Err() != nil {
					return
				}
				searchOneFile(path, matchLine, &mu, &matches, &filesSearched, hitLimit)
			}
		}()
	}
	wg.Wait()

	// 预算到点被 context 掐停的（没人再调 hitLimit）：也如实报 truncated
	if ctx.Err() == context.DeadlineExceeded {
		truncated = true
	}

	if matches == nil {
		matches = []fsSearchMatch{}
	}
	return map[string]interface{}{
		"matches":        matches,
		"truncated":      truncated,
		"files_searched": filesSearched,
		"elapsed_ms":     time.Since(started).Milliseconds(),
	}, nil
}

func searchOneFile(
	path string,
	matchLine func(string) int,
	mu *sync.Mutex,
	matches *[]fsSearchMatch,
	filesSearched *int,
	hitLimit func() bool,
) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	// 二进制判定：首 512 字节含 \0 整文件跳过（rg 同口径）
	head := make([]byte, 512)
	n, _ := f.Read(head)
	if n > 0 && strings.IndexByte(string(head[:n]), 0) >= 0 {
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return
	}
	mu.Lock()
	*filesSearched++
	mu.Unlock()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), fsSearchScannerBuf)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := sc.Text()
		col := matchLine(line)
		if col < 0 {
			continue
		}
		text := line
		if utf8.RuneCountInString(text) > fsSearchMaxLinePreview {
			text = string([]rune(text)[:fsSearchMaxLinePreview])
		}
		mu.Lock()
		// 先查后加（同一把锁保证原子）：撞线就不再追加，结果数不超上限
		if hitLimit() {
			mu.Unlock()
			return
		}
		*matches = append(*matches, fsSearchMatch{Path: path, Line: lineNo, Col: col, Text: text})
		mu.Unlock()
	}
}

// 文件系统方法：让应用能浏览/编辑容器（或宿主机）里的文件。
//
// 这是 Dev Containers  parity 的核心 —— vscode-server 在容器里提供的
// 第一项能力就是文件访问。协议走 NDJSON，二进制内容 base64。
// 0.4.0 起加了分块流式读写（fs_read_chunk / fs_write_begin|chunk|commit|abort）：
// 大文件传输直走这条通道（真进度、无宿主机中转、distroless 可传），
// 整读整写（fs_read/fs_write）仍服务编辑器小文件。
package main

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type fsEntry struct {
	Name      string `json:"name"`
	IsDir     bool   `json:"is_dir"`
	IsSymlink bool   `json:"is_symlink"`
	Size      int64  `json:"size"`
	Mtime     int64  `json:"mtime"`
}

// fsRead 单文件上限：协议是 JSON 行，base64 膨胀 4/3，
// 编辑器场景的文件（代码/配置/日志）远在这个量级之下
const fsReadMaxBytes = 16 * 1024 * 1024

func fsList(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, errors.New("fs_list 需要 path")
	}
	ents, err := os.ReadDir(p.Path)
	if err != nil {
		return nil, err
	}
	out := make([]fsEntry, 0, len(ents))
	for _, e := range ents {
		info, err := e.Info()
		if err != nil {
			continue // 读不到的条目（悬挂链接等）跳过，不让整个列表挂掉
		}
		out = append(out, fsEntry{
			Name:      e.Name(),
			IsDir:     e.IsDir(),
			IsSymlink: e.Type()&os.ModeSymlink != 0,
			Size:      info.Size(),
			Mtime:     info.ModTime().Unix(),
		})
	}
	return map[string]interface{}{"entries": out}, nil
}

func fsStat(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, errors.New("fs_stat 需要 path")
	}
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"is_dir": info.IsDir(),
		"size":   info.Size(),
		"mtime":  info.ModTime().Unix(),
	}, nil
}

// looksBinary：前 8KB 含 NUL 即视为二进制（编辑器据此拒绝打开，与主仓 SftpService 同款判定）
func looksBinary(sample []byte) bool {
	for _, b := range sample {
		if b == 0 {
			return true
		}
	}
	return false
}

func fsRead(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, errors.New("fs_read 需要 path")
	}
	f, err := os.Open(p.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("是目录，不是文件")
	}
	if info.Size() > fsReadMaxBytes {
		return nil, errors.New("文件超过 16MB，协议内读取不支持（用传输通道）")
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	sample := data
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	return map[string]interface{}{
		"data":   base64.StdEncoding.EncodeToString(data),
		"size":   info.Size(),
		"mtime":  info.ModTime().Unix(),
		"binary": looksBinary(sample),
	}, nil
}

func fsWrite(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path          string `json:"path"`
		Data          string `json:"data"` // base64
		ExpectedMtime *int64 `json:"expected_mtime"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, errors.New("fs_write 需要 path 与 data")
	}
	// 乐观锁：面板打开文件后远端被别人动过就拒绝覆盖（与 sftpWriteText 同款）
	if p.ExpectedMtime != nil {
		if info, err := os.Stat(p.Path); err == nil && info.ModTime().Unix() != *p.ExpectedMtime {
			return nil, errors.New("文件已被他人修改，拒绝覆盖（重新打开后再试）")
		}
	}
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return nil, errors.New("data 不是合法 base64")
	}
	// 先写临时文件再改名：写一半崩了不留下半截内容
	tmp := p.Path + ".dox-tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, p.Path); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"mtime": info.ModTime().Unix()}, nil
}

func fsMkdir(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, errors.New("fs_mkdir 需要 path")
	}
	if err := os.MkdirAll(p.Path, 0o755); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

// cleanInside：防路径穿越的最底线 —— 路径必须是干净的绝对路径。
// agent 的权限边界就是 SSH 会话本身（容器里是 docker exec 的身份），
// 这里防的是渲染层把 "../" 一路穿出预期目录的事故，不是防恶意用户。
func cleanInside(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("需要绝对路径: " + path)
	}
	clean := filepath.Clean(path)
	if strings.HasPrefix(clean, "/proc") || strings.HasPrefix(clean, "/sys") {
		return "", errors.New("/proc 与 /sys 不允许写操作")
	}
	return clean, nil
}

func fsRename(params json.RawMessage) (interface{}, error) {
	var p struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.From == "" || p.To == "" {
		return nil, errors.New("fs_rename 需要 from 与 to")
	}
	if _, err := cleanInside(p.To); err != nil {
		return nil, err
	}
	if err := os.Rename(p.From, p.To); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

func fsDelete(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, errors.New("fs_delete 需要 path")
	}
	clean, err := cleanInside(p.Path)
	if err != nil {
		return nil, err
	}
	// 递归删除的防线：/ 与近根目录永远拒绝，写死的清单不猜。
	// 深度按 / 计段；Windows 开发机上路径分隔符是 \（agent 只部署 Linux，
	// 那边 ToSlash 是恒等变换，行为零变化），不统一的话单测在 Windows 上
	// 会把任何临时目录误判成「过浅」。
	if p.Recursive {
		depthPath := filepath.ToSlash(clean)
		if clean == "/" || len(strings.Split(strings.Trim(depthPath, "/"), "/")) < 2 {
			return nil, errors.New("拒绝递归删除过浅的路径: " + clean)
		}
		if err := os.RemoveAll(clean); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
	if err := os.Remove(clean); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

// dispatchFS：fs_* 方法的统一分发（serve 主循环调用）
func dispatchFS(method string, params json.RawMessage) (interface{}, bool, error) {
	switch method {
	case "fs_list":
		r, err := fsList(params)
		return r, true, err
	case "fs_stat":
		r, err := fsStat(params)
		return r, true, err
	case "fs_read":
		r, err := fsRead(params)
		return r, true, err
	case "fs_write":
		r, err := fsWrite(params)
		return r, true, err
	case "fs_mkdir":
		r, err := fsMkdir(params)
		return r, true, err
	case "fs_rename":
		r, err := fsRename(params)
		return r, true, err
	case "fs_delete":
		r, err := fsDelete(params)
		return r, true, err
	case "fs_archive":
		r, err := fsArchive(params)
		return r, true, err
	case "fs_usage":
		r, err := fsUsage(params)
		return r, true, err
	case "fs_du":
		r, err := fsDu(params)
		return r, true, err
	case "fs_read_chunk":
		r, err := fsReadChunk(params)
		return r, true, err
	case "fs_write_begin":
		r, err := fsWriteBegin(params)
		return r, true, err
	case "fs_write_chunk":
		r, err := fsWriteChunk(params)
		return r, true, err
	case "fs_write_commit":
		r, err := fsWriteCommit(params)
		return r, true, err
	case "fs_write_abort":
		r, err := fsWriteAbort(params)
		return r, true, err
	}
	return nil, false, nil
}

// ---- fs_usage：statfs 某路径所在文件系统的容量 ----

func fsUsage(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, errors.New("fs_usage 需要 path")
	}
	bsize, blocks, bfree, bavail, err := statfsOf(p.Path)
	if err != nil {
		return nil, err
	}
	total := blocks * bsize
	free := bfree * bsize
	return map[string]interface{}{
		"total": total,
		"used":  total - free,
		"avail": bavail * bsize, // 非 root 可用（root 保留块之后）
		"mount": mountPointOf(p.Path),
	}, nil
}

// mountPointOf：/proc/mounts 里包含 path 的最长挂载点（展示用，不关键）
func mountPointOf(path string) string {
	raw, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return ""
	}
	best := ""
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		mp := f[1]
		if mp != "/" && !strings.HasPrefix(path, mp+"/") {
			continue
		}
		if len(mp) > len(best) {
			best = mp
		}
	}
	return best
}

// ---- fs_du：目录占用分解（「磁盘满了，谁占的？」）----

type duEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

/*
 * fs_du 把 path 的直接子项按子树大小排序返回（top N）。
 *
 * 防线（serve 是单线程分发，一次慢遍历不能把 watch_ports/stats 全堵死）：
 *  - 访问条目上限 50 万，耗时上限 15s，撞线就返回**部分结果**（truncated）
 *  - 不跨文件系统（du -x 口径）：/proc /sys /dev 这些虚拟 FS 不进树
 *  - 权限错误/中途消失的条目跳过，不让一个坏目录毁掉整个扫描
 *  - 符号链接算自身大小，不跟随（跟随会有环）
 */
const (
	duMaxVisited = 500_000
	duMaxElapsed = 15 * time.Second
	duTopN       = 50
)

func fsDu(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" || !filepath.IsAbs(p.Path) {
		return nil, errors.New("fs_du 需要绝对路径 path")
	}
	root, err := os.Stat(p.Path)
	if err != nil {
		return nil, err
	}
	if !root.IsDir() {
		return nil, errors.New("fs_du 的目标是目录")
	}
	rootDev := uint64(0)
	if dev, ok := devOf(root); ok {
		rootDev = dev
	}

	children, err := os.ReadDir(p.Path)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	visited := 0
	truncated := false

	// 子树累加器：返回该子树总大小；超限置 truncated 并提前收手
	var walk func(dir string) int64
	walk = func(dir string) int64 {
		if truncated {
			return 0
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return 0 // 权限/消失：跳过
		}
		var sum int64
		for _, e := range entries {
			visited++
			if visited > duMaxVisited || time.Since(started) > duMaxElapsed {
				truncated = true
				return sum
			}
			full := filepath.Join(dir, e.Name())
			info, err := e.Info()
			if err != nil {
				continue
			}
			if info.Mode()&os.ModeSymlink != 0 {
				sum += info.Size()
				continue
			}
			if !info.IsDir() {
				sum += info.Size()
				continue
			}
			if dev, ok := devOf(info); ok && dev != rootDev {
				sum += info.Size() // 挂载点目录本身算一个条目大小，子树不进
				continue
			}
			sum += info.Size() + walk(full)
		}
		return sum
	}

	var items []duEntry
	var total int64
	for _, c := range children {
		visited++
		info, err := c.Info()
		if err != nil {
			continue
		}
		size := info.Size()
		if info.Mode()&os.ModeSymlink == 0 && info.IsDir() {
			if dev, ok := devOf(info); !ok || dev == rootDev {
				size += walk(filepath.Join(p.Path, c.Name()))
			}
		}
		items = append(items, duEntry{
			Name:  c.Name(),
			Path:  filepath.Join(p.Path, c.Name()),
			IsDir: info.IsDir() && info.Mode()&os.ModeSymlink == 0,
			Size:  size,
		})
		total += size
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Size > items[j].Size })
	if len(items) > duTopN {
		items = items[:duTopN]
	}
	if items == nil {
		items = []duEntry{}
	}
	return map[string]interface{}{
		"path":      p.Path,
		"total":     total,
		"entries":   items,
		"truncated": truncated,
	}, nil
}

// ---- 分块流式读写：大文件传输直走 agent 通道（替代 SFTP+中转+docker cp 接力）----

const fsChunkMaxLen = 4 << 20 // 单块 4MB 上限

func fsReadChunk(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path   string `json:"path"`
		Offset int64  `json:"offset"`
		Length int    `json:"length"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, errors.New("fs_read_chunk 需要 path/offset/length")
	}
	if p.Offset < 0 || p.Length <= 0 || p.Length > fsChunkMaxLen {
		return nil, fmt.Errorf("offset/length 越界（单块上限 %d 字节）", fsChunkMaxLen)
	}
	f, err := os.Open(p.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("是目录，不是文件")
	}
	buf := make([]byte, p.Length)
	n, _ := f.ReadAt(buf, p.Offset)
	buf = buf[:n]
	return map[string]interface{}{
		"data":  base64.StdEncoding.EncodeToString(buf),
		"eof":   p.Offset+int64(n) >= info.Size(),
		"size":  info.Size(),
		"mtime": info.ModTime().Unix(),
	}, nil
}

// doxTmpMarker：分块写临时名的标记。commit/abort 只认带这个标记的路径，
// 否则一个构造好的 tmp 参数就能把任意文件 rename 走 / 删掉。
const doxTmpMarker = ".dox-tmp-"

func guardTmpPath(tmp string) error {
	if !filepath.IsAbs(tmp) || !strings.Contains(filepath.Base(tmp), doxTmpMarker) {
		return errors.New("非法的临时文件路径")
	}
	return nil
}

/*
 * fs_write_begin 的临时名是**确定性**的（path 的 sha1 前 8 位）：
 * 同一个目标路径的两次上传拿到同一个 tmp —— 上次传到一半失败留下的
 * 半截 tmp 就能被这次续上（existing_size 告诉调用方从哪儿继续）。
 * 随机名 + O_EXCL 做不到这件事：每次 begin 都是新文件，半截永远是垃圾。
 *
 * 代价：同一目标路径的并发上传会写同一个 tmp（字节交错损坏）。
 * 传输队列对同目标的并发上传本来就是反常操作，按「不支持」处理，
 * 不为此放弃续传。注意 marker 仍在，guardTmpPath 语义不变。
 */
func tmpPathFor(path string) string {
	sum := sha1.Sum([]byte(path))
	return path + doxTmpMarker + hex.EncodeToString(sum[:4])
}

func fsWriteBegin(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" || !filepath.IsAbs(p.Path) {
		return nil, errors.New("fs_write_begin 需要绝对路径 path")
	}
	tmp := tmpPathFor(p.Path)
	var existing int64
	if info, err := os.Stat(tmp); err == nil {
		existing = info.Size()
	}
	// 没有 O_EXCL：续传就是「已存在就接着写」
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	_ = f.Close()
	return map[string]interface{}{"tmp": tmp, "existing_size": existing}, nil
}

func fsWriteChunk(params json.RawMessage) (interface{}, error) {
	var p struct {
		Tmp    string `json:"tmp"`
		Offset int64  `json:"offset"`
		Data   string `json:"data"` // base64
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Tmp == "" {
		return nil, errors.New("fs_write_chunk 需要 tmp/offset/data")
	}
	if err := guardTmpPath(p.Tmp); err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return nil, errors.New("data 不是合法 base64")
	}
	if len(data) > fsChunkMaxLen {
		return nil, fmt.Errorf("单块超过 %d 字节上限", fsChunkMaxLen)
	}
	f, err := os.OpenFile(p.Tmp, os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.WriteAt(data, p.Offset); err != nil {
		return nil, err
	}
	return map[string]int{"written": len(data)}, nil
}

func fsWriteCommit(params json.RawMessage) (interface{}, error) {
	var p struct {
		Tmp           string `json:"tmp"`
		Path          string `json:"path"`
		ExpectedMtime *int64 `json:"expected_mtime"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Tmp == "" || p.Path == "" {
		return nil, errors.New("fs_write_commit 需要 tmp 与 path")
	}
	if err := guardTmpPath(p.Tmp); err != nil {
		return nil, err
	}
	// 乐观锁：与 fs_write 同一条判定（两处文案保持一致，渲染层靠它认冲突）。
	// 冲突时顺手删掉临时文件：commit 是最后一步，被拒后这份内容已无用处，
	// 留着只会随失败传输堆积
	if p.ExpectedMtime != nil {
		if info, err := os.Stat(p.Path); err == nil && info.ModTime().Unix() != *p.ExpectedMtime {
			_ = os.Remove(p.Tmp)
			return nil, errors.New("文件已被他人修改，拒绝覆盖（重新打开后再试）")
		}
	}
	if err := os.Rename(p.Tmp, p.Path); err != nil {
		_ = os.Remove(p.Tmp)
		return nil, err
	}
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, err
	}
	return map[string]int64{"mtime": info.ModTime().Unix()}, nil
}

func fsWriteAbort(params json.RawMessage) (interface{}, error) {
	var p struct {
		Tmp string `json:"tmp"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Tmp == "" {
		return nil, errors.New("fs_write_abort 需要 tmp")
	}
	if err := guardTmpPath(p.Tmp); err != nil {
		return nil, err
	}
	_ = os.Remove(p.Tmp)
	return map[string]bool{"ok": true}, nil
}

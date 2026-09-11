// 文件系统方法：让应用能浏览/编辑容器（或宿主机）里的文件。
//
// 这是 Dev Containers  parity 的核心 —— vscode-server 在容器里提供的
// 第一项能力就是文件访问。协议走 NDJSON，二进制内容 base64。
// 0.4.0 起加了分块流式读写（fs_read_chunk / fs_write_begin|chunk|commit|abort）：
// 大文件传输直走这条通道（真进度、无宿主机中转、distroless 可传），
// 整读整写（fs_read/fs_write）仍服务编辑器小文件。
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
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
	// 递归删除的防线：/ 与近根目录永远拒绝，写死的清单不猜
	if p.Recursive {
		if clean == "/" || len(strings.Split(strings.Trim(clean, "/"), "/")) < 2 {
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
	var st syscall.Statfs_t
	if err := syscall.Statfs(p.Path, &st); err != nil {
		return nil, err
	}
	bsize := uint64(st.Bsize)
	total := st.Blocks * bsize
	free := st.Bfree * bsize
	return map[string]interface{}{
		"total": total,
		"used":  total - free,
		"avail": st.Bavail * bsize, // 非 root 可用（root 保留块之后）
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

func fsWriteBegin(params json.RawMessage) (interface{}, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" || !filepath.IsAbs(p.Path) {
		return nil, errors.New("fs_write_begin 需要绝对路径 path")
	}
	rand4 := make([]byte, 4)
	if _, err := rand.Read(rand4); err != nil {
		return nil, err
	}
	tmp := p.Path + doxTmpMarker + hex.EncodeToString(rand4)
	// O_EXCL：绝不覆盖已存在的文件
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	_ = f.Close()
	return map[string]string{"tmp": tmp}, nil
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

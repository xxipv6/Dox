// 文件系统方法：让应用能浏览/编辑容器（或宿主机）里的文件。
//
// 这是 Dev Containers  parity 的核心 —— vscode-server 在容器里提供的
// 第一项能力就是文件访问。协议走 NDJSON，二进制内容 base64；
// 大文件传输（上传/下载）刻意**不**走这里 —— 那是宿主机 /tmp 中转
// docker cp 的活，协议内传大文件又慢又占内存。
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
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
	}
	return nil, false, nil
}

// 目录归档流：不依赖目标里的 tar，也不先落一个临时归档。
//
// 下载由 agent 用 archive/tar 产流，按 credit 窗口推送 archive 事件；
// 上传由应用产 tar 字节，按 offset 送块，agent 用 archive/tar 边收边解。
// 两种会话都挂在 serve 通道生命周期上，stop/断线会统一取消。
package main

import (
	"archive/tar"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	pathpkg "path"
	"path/filepath"
	"strings"
	"sync"
)

const (
	archiveStreamChunk      = 1024 * 1024
	archiveStreamWindow     = 6
	archiveExtractMaxBuffer = 8 * archiveStreamChunk
)

func isArchiveStreamMethod(method string) bool {
	switch method {
	case "fs_archive_start", "fs_archive_ack", "fs_archive_cancel",
		"fs_extract_begin", "fs_extract_chunk", "fs_extract_commit", "fs_extract_abort":
		return true
	default:
		return false
	}
}

type archiveStream interface {
	close(error)
}

type archiveStreamHub struct {
	enc     *safeEncoder
	mu      sync.Mutex
	streams map[string]archiveStream
}

func newArchiveStreamHub(enc *safeEncoder) *archiveStreamHub {
	return &archiveStreamHub{enc: enc, streams: make(map[string]archiveStream)}
}

func validArchiveStreamID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func (h *archiveStreamHub) add(id string, stream archiveStream) error {
	if !validArchiveStreamID(id) {
		return errors.New("非法归档流 id")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, exists := h.streams[id]; exists {
		return errors.New("归档流 id 已存在")
	}
	h.streams[id] = stream
	return nil
}

func (h *archiveStreamHub) remove(id string) {
	h.mu.Lock()
	delete(h.streams, id)
	h.mu.Unlock()
}

func (h *archiveStreamHub) download(id string) (*archiveDownload, error) {
	h.mu.Lock()
	s := h.streams[id]
	h.mu.Unlock()
	d, ok := s.(*archiveDownload)
	if !ok {
		return nil, errors.New("归档下载流不存在或已结束")
	}
	return d, nil
}

func (h *archiveStreamHub) extract(id string) (*archiveExtract, error) {
	h.mu.Lock()
	s := h.streams[id]
	h.mu.Unlock()
	e, ok := s.(*archiveExtract)
	if !ok {
		return nil, errors.New("归档上传流不存在或已结束")
	}
	return e, nil
}

func (h *archiveStreamHub) emit(id, kind, data string, err error) {
	payload := map[string]interface{}{"id": id, "type": kind}
	if data != "" {
		payload["data"] = data
	}
	if err != nil {
		payload["error"] = err.Error()
	}
	_ = h.enc.Encode(event{Event: "archive", Data: payload})
}

func (h *archiveStreamHub) closeAll() {
	h.mu.Lock()
	streams := make([]archiveStream, 0, len(h.streams))
	for _, s := range h.streams {
		streams = append(streams, s)
	}
	h.streams = make(map[string]archiveStream)
	h.mu.Unlock()
	for _, s := range streams {
		s.close(errors.New("agent 通道已关闭"))
	}
}

func (h *archiveStreamHub) dispatch(method string, params json.RawMessage) (interface{}, error) {
	switch method {
	case "fs_archive_start":
		var p struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return nil, h.startDownload(p.ID, p.Path)
	case "fs_archive_ack":
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		d, err := h.download(p.ID)
		if err != nil {
			// done/cancel 与迟到的 ack 可以合法交错，幂等吞掉即可。
			return map[string]bool{"ok": true}, nil
		}
		d.ack()
		return map[string]bool{"ok": true}, nil
	case "fs_archive_cancel":
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if d, err := h.download(p.ID); err == nil {
			h.remove(p.ID)
			d.close(errors.New("归档下载已取消"))
		}
		return map[string]bool{"ok": true}, nil
	case "fs_extract_begin":
		var p struct {
			ID   string `json:"id"`
			Path string `json:"path"`
			Size int64  `json:"size"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return nil, h.startExtract(p.ID, p.Path, p.Size)
	case "fs_extract_chunk":
		var p struct {
			ID     string `json:"id"`
			Offset int64  `json:"offset"`
			Data   string `json:"data"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		data, err := base64.StdEncoding.DecodeString(p.Data)
		if err != nil {
			return nil, errors.New("归档块不是合法 base64")
		}
		if len(data) > archiveStreamChunk {
			return nil, errors.New("归档块超过 1MiB 上限")
		}
		e, err := h.extract(p.ID)
		if err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, e.write(p.Offset, data)
	case "fs_extract_commit":
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		e, err := h.extract(p.ID)
		if err != nil {
			return nil, err
		}
		if err := e.commit(); err != nil {
			return nil, err
		}
		h.remove(p.ID)
		return map[string]bool{"ok": true}, nil
	case "fs_extract_abort":
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if e, err := h.extract(p.ID); err == nil {
			h.remove(p.ID)
			e.close(errors.New("归档上传已取消"))
		}
		return map[string]bool{"ok": true}, nil
	default:
		return nil, errors.New("unknown archive method: " + method)
	}
}

// ---- 下载：本地目录 → tar → credit 窗口内的 archive 事件 ----

type archiveDownload struct {
	id         string
	hub        *archiveStreamHub
	reader     *io.PipeReader
	writer     *io.PipeWriter
	closeOnce  sync.Once
	creditMu   sync.Mutex
	creditCond *sync.Cond
	credit     int
	closed     bool
}

func (h *archiveStreamHub) startDownload(id, root string) error {
	if !filepath.IsAbs(root) {
		return errors.New("归档目录需要绝对路径")
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("归档目标不是目录（根符号链接不跟随）")
	}
	reader, writer := io.Pipe()
	d := &archiveDownload{
		id: id, hub: h, reader: reader, writer: writer,
		credit: archiveStreamWindow,
	}
	d.creditCond = sync.NewCond(&d.creditMu)
	if err := h.add(id, d); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return err
	}
	go d.produce(root)
	go d.pump()
	return nil
}

func (d *archiveDownload) produce(root string) {
	err := writeArchiveTar(d.writer, root)
	_ = d.writer.CloseWithError(err)
}

func (d *archiveDownload) pump() {
	defer func() {
		d.hub.remove(d.id)
		_ = d.reader.Close()
	}()
	buf := make([]byte, archiveStreamChunk)
	for {
		n, err := d.reader.Read(buf)
		if n > 0 {
			// tar.Writer 会向 pipe 写零长度块；PipeReader 对应返回 (0, nil)。
			// credit 必须只给真正的数据帧，否则空读会耗尽窗口并永久卡住。
			if !d.waitCredit() {
				return
			}
			d.hub.emit(d.id, "data", base64.StdEncoding.EncodeToString(buf[:n]), nil)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				d.hub.emit(d.id, "done", "", nil)
			} else {
				d.hub.emit(d.id, "done", "", err)
			}
			return
		}
	}
}

func (d *archiveDownload) waitCredit() bool {
	d.creditMu.Lock()
	defer d.creditMu.Unlock()
	for d.credit == 0 && !d.closed {
		d.creditCond.Wait()
	}
	if d.closed {
		return false
	}
	d.credit--
	return true
}

func (d *archiveDownload) ack() {
	d.creditMu.Lock()
	if !d.closed && d.credit < archiveStreamWindow {
		d.credit++
		d.creditCond.Signal()
	}
	d.creditMu.Unlock()
}

func (d *archiveDownload) close(err error) {
	d.closeOnce.Do(func() {
		d.creditMu.Lock()
		d.closed = true
		d.creditCond.Broadcast()
		d.creditMu.Unlock()
		_ = d.reader.CloseWithError(err)
		_ = d.writer.CloseWithError(err)
	})
}

func writeArchiveTar(w io.Writer, root string) error {
	tw := tar.NewWriter(w)
	cleanRoot := filepath.Clean(root)
	base := filepath.Base(cleanRoot)
	if base == "." || base == string(filepath.Separator) || base == "" {
		base = "root"
	}
	err := filepath.WalkDir(cleanRoot, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		// 与既有传输口径一致：符号链接按不支持处理，绝不跟进目标目录。
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(cleanRoot, p)
		if err != nil {
			return err
		}
		name := base
		if rel != "." {
			name = pathpkg.Join(base, filepath.ToSlash(rel))
		}
		if info.IsDir() {
			name += "/"
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = name
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.IsDir() || !info.Mode().IsRegular() {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		_, copyErr := io.CopyN(tw, f, info.Size())
		closeErr := f.Close()
		if copyErr != nil {
			return fmt.Errorf("读取 %s: %w", p, copyErr)
		}
		return closeErr
	})
	if err != nil {
		_ = tw.Close()
		return err
	}
	return tw.Close()
}

// ---- 上传：offset 分块 → 有序 pipe → archive/tar 解到正式目录 ----

type archiveExtract struct {
	id        string
	hub       *archiveStreamHub
	dest      string
	expected  int64
	reader    *io.PipeReader
	writer    *io.PipeWriter
	closeOnce sync.Once
	mu        sync.Mutex
	next      int64
	received  int64
	buffered  int64
	pending   map[int64][]byte
	finished  bool
	err       error
	done      chan struct{}
}

func (h *archiveStreamHub) startExtract(id, dest string, expected int64) error {
	if !filepath.IsAbs(dest) || expected < 0 {
		return errors.New("解压目录需要绝对路径，归档大小不能为负")
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	// 根目录本身可以是用户明确选择的链接；解析后以其真实位置作为边界。
	resolved, err := filepath.EvalSymlinks(dest)
	if err != nil {
		return err
	}
	reader, writer := io.Pipe()
	e := &archiveExtract{
		id: id, hub: h, dest: resolved, expected: expected,
		reader: reader, writer: writer,
		pending: make(map[int64][]byte), done: make(chan struct{}),
	}
	if err := h.add(id, e); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return err
	}
	go func() {
		err := extractArchiveTar(reader, e.dest)
		e.finish(err)
	}()
	return nil
}

func (e *archiveExtract) finish(err error) {
	// 先关 pipe，再拿写锁：Write 可能正阻塞等 reader，反序会死锁。
	_ = e.reader.CloseWithError(err)
	_ = e.writer.CloseWithError(err)
	e.mu.Lock()
	if !e.finished {
		e.finished = true
		e.err = err
		close(e.done)
	}
	e.mu.Unlock()
}

func (e *archiveExtract) close(err error) {
	e.closeOnce.Do(func() {
		_ = e.reader.CloseWithError(err)
		_ = e.writer.CloseWithError(err)
		e.mu.Lock()
		if !e.finished {
			e.finished = true
			e.err = err
			close(e.done)
		}
		e.pending = nil
		e.mu.Unlock()
	})
}

func (e *archiveExtract) write(offset int64, data []byte) error {
	if offset < 0 || offset > e.expected || int64(len(data)) > e.expected-offset {
		return errors.New("归档块 offset/长度越界")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.finished {
		if e.err != nil {
			return e.err
		}
		return errors.New("归档上传流已结束")
	}
	if offset < e.next {
		return errors.New("归档块 offset 重复或重叠")
	}
	if _, exists := e.pending[offset]; exists {
		return errors.New("归档块 offset 重复")
	}
	if e.buffered+int64(len(data)) > archiveExtractMaxBuffer {
		return errors.New("归档乱序缓冲超过上限")
	}
	e.pending[offset] = data
	e.buffered += int64(len(data))
	e.received += int64(len(data))
	for {
		chunk, ok := e.pending[e.next]
		if !ok {
			break
		}
		delete(e.pending, e.next)
		e.buffered -= int64(len(chunk))
		if _, err := e.writer.Write(chunk); err != nil {
			return err
		}
		e.next += int64(len(chunk))
	}
	return nil
}

func (e *archiveExtract) commit() error {
	e.mu.Lock()
	if e.finished {
		err := e.err
		complete := e.next == e.expected && e.received == e.expected && len(e.pending) == 0
		e.mu.Unlock()
		if err != nil {
			return err
		}
		// archive/tar 读到结束块就会先返回 EOF，此时数据已经完整，
		// commit 是确认成功，不是“向已结束的流继续写入”。
		if !complete {
			return fmt.Errorf("归档数据不完整：已接收连续 %d/%d 字节", e.next, e.expected)
		}
		return nil
	}
	if e.next != e.expected || e.received != e.expected || len(e.pending) != 0 {
		e.mu.Unlock()
		return fmt.Errorf("归档数据不完整：已接收连续 %d/%d 字节", e.next, e.expected)
	}
	if err := e.writer.Close(); err != nil {
		e.mu.Unlock()
		return err
	}
	e.mu.Unlock()
	<-e.done
	e.mu.Lock()
	err := e.err
	e.mu.Unlock()
	return err
}

func extractArchiveTar(r io.Reader, dest string) error {
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := safeArchiveExtractPath(dest, hdr.Name)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := makeArchiveDir(dest, target, hdr.FileInfo().Mode().Perm()); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := makeArchiveDir(dest, filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("拒绝经符号链接写入：%s", target)
			}
			mode := hdr.FileInfo().Mode().Perm()
			if mode == 0 {
				mode = 0o644
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(f, tr)
			closeErr := f.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			if !hdr.ModTime.IsZero() {
				_ = os.Chtimes(target, hdr.ModTime, hdr.ModTime)
			}
		default:
			// 链接、设备等与既有 TarParser 一样跳过，不在目标侧创建特殊对象。
		}
	}
}

func safeArchiveExtractPath(dest, name string) (string, error) {
	if name == "" || strings.ContainsRune(name, '\x00') || pathpkg.IsAbs(name) {
		return "", errors.New("归档条目路径非法: " + name)
	}
	clean := pathpkg.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("归档条目越过目标目录: " + name)
	}
	target := filepath.Join(dest, filepath.FromSlash(clean))
	rel, err := filepath.Rel(dest, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("归档条目越过目标目录: " + name)
	}
	return target, nil
}

// 逐级检查已存在的父目录，拒绝利用目标目录里的旧符号链接把文件写出根外。
func makeArchiveDir(root, dir string, mode os.FileMode) error {
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("归档父目录越过目标根")
	}
	if rel == "." {
		return nil
	}
	// Windows 来源的目录 mode 可能没有执行位；新建目录至少保证 owner
	// 可进入/读写，否则第一个子文件就会因权限不足解不下去。
	mode |= 0o700
	cur := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, part)
		info, err := os.Lstat(cur)
		if err != nil {
			if !os.IsNotExist(err) {
				return err
			}
			if err := os.Mkdir(cur, mode); err != nil && !os.IsExist(err) {
				return err
			}
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("归档父目录不是实际目录：%s", cur)
		}
	}
	return nil
}

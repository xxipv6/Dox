package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestArchiveExtractCommitAfterTarEOF(t *testing.T) {
	var stream bytes.Buffer
	tw := tar.NewWriter(&stream)
	content := []byte("archive-content")
	if err := tw.WriteHeader(&tar.Header{Name: "root/a.txt", Mode: 0o644, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}

	hub := newArchiveStreamHub(&safeEncoder{enc: json.NewEncoder(io.Discard)})
	dest := t.TempDir()
	if err := hub.startExtract("upload", dest, int64(stream.Len())); err != nil {
		t.Fatal(err)
	}
	e, err := hub.extract("upload")
	if err != nil {
		t.Fatal(err)
	}
	if err := e.write(0, stream.Bytes()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-e.done:
	case <-time.After(2 * time.Second):
		t.Fatal("解压没有及时读到 tar EOF")
	}
	if err := e.commit(); err != nil {
		t.Fatalf("正常 tar EOF 后 commit 应成功: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "root", "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("内容不一致: %q", got)
	}
}

type archiveEventCapture struct {
	ch chan []byte
}

func (w archiveEventCapture) Write(p []byte) (int, error) {
	w.ch <- bytes.Clone(p)
	return len(p), nil
}

func TestArchiveDownloadProducesDataAndDone(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "root"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "root", "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	capture := archiveEventCapture{ch: make(chan []byte)}
	hub := newArchiveStreamHub(&safeEncoder{enc: json.NewEncoder(capture)})
	defer hub.closeAll()
	if err := hub.startDownload("download", filepath.Join(root, "root")); err != nil {
		t.Fatal(err)
	}
	sawData := false
	for {
		select {
		case frame := <-capture.ch:
			var ev event
			if err := json.Unmarshal(frame, &ev); err != nil {
				t.Fatal(err)
			}
			data := ev.Data.(map[string]interface{})
			if data["type"] == "data" {
				sawData = true
				if _, err := hub.dispatch("fs_archive_ack", json.RawMessage(`{"id":"download"}`)); err != nil {
					t.Fatal(err)
				}
			}
			if data["type"] == "done" {
				if !sawData {
					t.Fatal("done 之前没有数据帧")
				}
				return
			}
		case <-time.After(2 * time.Second):
			t.Fatal("归档下载没有产出数据/完成事件")
		}
	}
}

func TestArchiveDownloadIgnoresEmptyPipeWrites(t *testing.T) {
	capture := archiveEventCapture{ch: make(chan []byte, 16)}
	hub := newArchiveStreamHub(&safeEncoder{enc: json.NewEncoder(capture)})
	defer hub.closeAll()
	reader, writer := io.Pipe()
	d := &archiveDownload{
		id: "empty-writes", hub: hub, reader: reader, writer: writer,
		credit: archiveStreamWindow,
	}
	d.creditCond = sync.NewCond(&d.creditMu)
	if err := hub.add(d.id, d); err != nil {
		t.Fatal(err)
	}
	go d.pump()
	go func() {
		// archive/tar 的 Flush/空文件会产生这种写入；旧实现会在这里耗尽 credit。
		for i := 0; i < archiveStreamWindow; i++ {
			if _, err := writer.Write(nil); err != nil {
				return
			}
		}
		_, _ = writer.Write(bytes.Repeat([]byte{0x5a}, 512))
		_ = writer.Close()
	}()

	sawData := false
	for {
		select {
		case frame := <-capture.ch:
			var ev event
			if err := json.Unmarshal(frame, &ev); err != nil {
				t.Fatal(err)
			}
			data := ev.Data.(map[string]interface{})
			switch data["type"] {
			case "data":
				sawData = true
				d.ack()
			case "done":
				if !sawData {
					t.Fatal("空写之后没有收到真正的数据帧")
				}
				if data["error"] != nil {
					t.Fatalf("下载失败: %v", data["error"])
				}
				return
			}
		case <-time.After(2 * time.Second):
			t.Fatal("零长度 pipe 写耗尽了下载 credit")
		}
	}
}

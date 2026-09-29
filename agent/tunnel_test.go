package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// hub 的事件出口是 safeEncoder（钉死 *json.Encoder），测试里用真实管道代替 stdout，
// 从另一头按行读 NDJSON —— 与线上「事件行进 serve 通道」同一形态。
func newPipeHub(t *testing.T) (*tunnelHub, *bufio.Reader) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close(); _ = w.Close() })
	hub := newTunnelHub(&safeEncoder{enc: json.NewEncoder(w)})
	return hub, bufio.NewReader(r)
}

func readTunnelEvent(t *testing.T, r *bufio.Reader, op string) tunnelEventData {
	t.Helper()
	type line struct {
		Event string          `json:"event"`
		Data  tunnelEventData `json:"data"`
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_ = r
		b, err := readLineWithDeadline(r, deadline)
		if err != nil {
			t.Fatalf("读事件流: %v", err)
		}
		var l line
		if err := json.Unmarshal(b, &l); err != nil || l.Event != "tunnel" {
			continue
		}
		if l.Data.Op == op {
			return l.Data
		}
	}
	t.Fatalf("等不到 %s 事件", op)
	return tunnelEventData{}
}

// bufio.Reader 没有超时读：事件都是 goroutine 异步来的，测试线程直接阻塞读，
// 真等不到时靠外层 deadline 检查后由 t.Fatal 兜住 —— 但 ReadBytes 本身会卡死，
// 所以起 goroutine 读一行送进 channel，主线程带超时等。
func readLineWithDeadline(r *bufio.Reader, deadline time.Time) ([]byte, error) {
	type res struct {
		b   []byte
		err error
	}
	ch := make(chan res, 1)
	go func() {
		b, err := r.ReadBytes('\n')
		ch <- res{b, err}
	}()
	select {
	case v := <-ch:
		return v.b, v.err
	case <-time.After(time.Until(deadline)):
		return nil, errors.New("读事件超时")
	}
}

func startTestTunnel(t *testing.T, hub *tunnelHub, id string) string {
	t.Helper()
	res, err := hub.start(json.RawMessage(`{"id":"`+id+`","listen_addr":"127.0.0.1:0"}`))
	if err != nil {
		t.Fatal(err)
	}
	return res.(map[string]interface{})["addr"].(string)
}

// 完整往返：open → 上行 data → 下行 data → 对端断开 → close
func TestTunnelEchoRoundtrip(t *testing.T) {
	hub, events := newPipeHub(t)
	defer hub.closeAll()
	addr := startTestTunnel(t, hub, "t1")

	// 模拟容器里的应用连进来
	nc, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = nc.Close() }()

	open := readTunnelEvent(t, events, "open")
	if open.ID != "t1" || open.Conn == 0 {
		t.Fatalf("open 帧不对: %+v", open)
	}

	// 容器 → 应用
	if _, err := nc.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	data := readTunnelEvent(t, events, "data")
	if data.Conn != open.Conn {
		t.Fatalf("data 帧 conn 不对: %+v", data)
	}
	if got, _ := base64.StdEncoding.DecodeString(data.Data); string(got) != "ping" {
		t.Fatalf("上行数据不对: %q", data.Data)
	}

	// 应用 → 容器
	raw, _ := json.Marshal(map[string]interface{}{"id": "t1", "conn": open.Conn, "data": base64.StdEncoding.EncodeToString([]byte("pong"))})
	if err := hub.data(raw); err != nil {
		t.Fatal(err)
	}
	_ = nc.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	n, err := nc.Read(buf)
	if err != nil || string(buf[:n]) != "pong" {
		t.Fatalf("下行数据不对: n=%d err=%v", n, err)
	}

	// 容器侧断开 → 应用收到 close
	_ = nc.Close()
	cls := readTunnelEvent(t, events, "close")
	if cls.Conn != open.Conn {
		t.Fatalf("close 帧 conn 不对: %+v", cls)
	}
}

func TestTunnelStartDupAndBadParams(t *testing.T) {
	hub, _ := newPipeHub(t)
	defer hub.closeAll()

	if _, err := hub.start(json.RawMessage(`{"id":"","listen_addr":""}`)); err == nil {
		t.Fatal("空参数必须拒绝")
	}
	startTestTunnel(t, hub, "t1")
	if _, err := hub.start(json.RawMessage(`{"id":"t1","listen_addr":"127.0.0.1:0"}`)); !errors.Is(err, errTunnelExists) {
		t.Fatalf("重复 id 应报 errTunnelExists: %v", err)
	}
}

// tunnel_close 不带 conn = 整条隧道停掉：监听死 + 在跑的连接收到 close
func TestTunnelCloseWhole(t *testing.T) {
	hub, events := newPipeHub(t)
	addr := startTestTunnel(t, hub, "t1")
	defer hub.closeAll()

	nc, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = nc.Close() }()
	open := readTunnelEvent(t, events, "open")

	raw, _ := json.Marshal(map[string]interface{}{"id": "t1"})
	if err := hub.closeTunnel(raw); err != nil {
		t.Fatal(err)
	}
	cls := readTunnelEvent(t, events, "close")
	if cls.Conn != open.Conn {
		t.Fatalf("close 帧 conn 不对: %+v", cls)
	}
	// 监听已停：再连应该被拒
	if _, err := net.Dial("tcp", addr); err == nil {
		t.Fatal("隧道关了监听还在")
	}
}

// 晚到的数据帧（连接已死）：不报错、不 panic，静默丢弃
func TestTunnelDataAfterClose(t *testing.T) {
	hub, events := newPipeHub(t)
	addr := startTestTunnel(t, hub, "t1")
	defer hub.closeAll()

	nc, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	open := readTunnelEvent(t, events, "open")
	_ = nc.Close()
	readTunnelEvent(t, events, "close")

	raw, _ := json.Marshal(map[string]interface{}{"id": "t1", "conn": open.Conn, "data": base64.StdEncoding.EncodeToString([]byte("late"))})
	if err := hub.data(raw); err != nil {
		t.Fatalf("晚到的数据帧不该报错: %v", err)
	}
}

// 拨号模式（容器 -L）：tunnel_connect 让 agent 去拨目标，open 确认、数据双向、close 收口
func TestTunnelDial(t *testing.T) {
	// 目标：测试里起一个 echo server
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); c.Close() }()
		}
	}()

	hub, events := newPipeHub(t)
	defer hub.closeAll()

	raw, _ := json.Marshal(map[string]interface{}{"id": "d1", "conn": 42, "target_addr": echo.Addr().String()})
	res, err := hub.dial(raw)
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]bool)["accepted"] != true {
		t.Fatal("拨号应被接受（异步拨，结果看 open/close 帧）")
	}
	open := readTunnelEvent(t, events, "open")
	if open.Conn != 42 || open.ID != "d1" {
		t.Fatalf("open 帧不对: %+v", open)
	}

	// 应用 → 目标（经 agent 拨的连接）
	raw, _ = json.Marshal(map[string]interface{}{"id": "d1", "conn": 42, "data": base64.StdEncoding.EncodeToString([]byte("hello"))})
	if err := hub.data(raw); err != nil {
		t.Fatal(err)
	}
	// echo 回来 → 目标 → 应用
	data := readTunnelEvent(t, events, "data")
	if got, _ := base64.StdEncoding.DecodeString(data.Data); string(got) != "hello" {
		t.Fatalf("回显不对: %q", data.Data)
	}

	// 关整条隧道：dial 连接也要被收掉（dials 不属于任何 listener）
	raw, _ = json.Marshal(map[string]interface{}{"id": "d1"})
	if err := hub.closeTunnel(raw); err != nil {
		t.Fatal(err)
	}
	cls := readTunnelEvent(t, events, "close")
	if cls.Conn != 42 {
		t.Fatalf("close 帧 conn 不对: %+v", cls)
	}
}

// 拨号失败：不是协议错误，回 close+err 帧让应用侧关连接
func TestTunnelDialFail(t *testing.T) {
	hub, events := newPipeHub(t)
	defer hub.closeAll()

	raw, _ := json.Marshal(map[string]interface{}{"id": "d1", "conn": 7, "target_addr": "127.0.0.1:1"})
	res, err := hub.dial(raw)
	if err != nil {
		t.Fatalf("拨号失败不该是协议错误: %v", err)
	}
	if res.(map[string]bool)["accepted"] != true {
		t.Fatal("应先接受再异步拨号")
	}
	cls := readTunnelEvent(t, events, "close")
	if cls.Conn != 7 || cls.Err == "" {
		t.Fatalf("close 帧应带 err: %+v", cls)
	}
}

// 发送队列溢出：对端不读还继续灌 → 这条连接被断开（保护 serve 主循环不被堵死）
func TestTunnelSendOverflow(t *testing.T) {
	hub, events := newPipeHub(t)
	addr := startTestTunnel(t, hub, "t1")
	defer hub.closeAll()

	nc, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = nc.Close() }()
	open := readTunnelEvent(t, events, "open")

	// 事件流要继续读（close 事件在里面），但 nc 一个字节都不读
	closed := make(chan tunnelEventData, 1)
	go func() {
		for {
			b, err := events.ReadBytes('\n')
			if err != nil {
				return
			}
			var l struct {
				Event string          `json:"event"`
				Data  tunnelEventData `json:"data"`
			}
			if json.Unmarshal(b, &l) == nil && l.Event == "tunnel" && l.Data.Op == "close" {
				closed <- l.Data
				return
			}
		}
	}()

	// 每帧 64KB，灌 3 倍队列容量：writeLoop 一旦写不动（nc 不读），队列必满
	chunk := base64.StdEncoding.EncodeToString(make([]byte, 64*1024))
	for i := 0; i < tunnelSendBufCap*3+64; i++ {
		raw, _ := json.Marshal(map[string]interface{}{"id": "t1", "conn": open.Conn, "data": chunk})
		_ = hub.data(raw)
	}
	select {
	case ev := <-closed:
		if !strings.Contains(ev.Err, "溢出") && ev.Err == "" {
			t.Fatalf("溢出断开的 err 应说明原因: %+v", ev)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("队列溢出后连接没被断开")
	}
}

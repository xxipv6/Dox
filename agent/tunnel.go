// 端口隧道：在 agent 所在的网络命名空间里起 TCP 监听（容器助手 = 容器内，
// 宿主机助手 = 宿主机上），入站连接经 serve 通道的 NDJSON 帧多路复用回应用，
// 由应用侧拨真正的目标地址。
//
// 帧格式（agent → 应用）：
//   {"event":"tunnel","data":{"id":"规则id","conn":7,"op":"open"}}
//   {"event":"tunnel","data":{"id":"规则id","conn":7,"op":"data","data":"base64…"}}
//   {"event":"tunnel","data":{"id":"规则id","conn":7,"op":"close","err":"…"}}
// 应用 → agent（请求/响应）：
//   tunnel_start  {id, listen_addr}            → {listening:true}（重复 id = 幂等重开）
//   tunnel_data   {id, conn, data(base64)}     → {}（无响应语义，回包只是时序确认）
//   tunnel_close  {id, conn?}                  → {}（conn 缺省 = 整条隧道停掉）
//
// 背压：conn→应用方向靠「同步写 stdout」自然传导（应用读得慢，agent 写阻塞，
// conn 读循环跟着停，内核缓冲顶回对端）。应用→conn 方向走每连接有界队列，
// 队列满直接断这条连接 —— 宁可断流也不让一条慢连接堵死 serve 主循环
// （主循环还背着 watch/fs/其他隧道）。
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

const (
	tunnelChunkSize   = 32 * 1024
	tunnelSendBufCap  = 256 // 每连接待发队列上限（256 × 32KB = 8MB）
)

type tunnelEventData struct {
	ID   string `json:"id"`
	Conn uint64 `json:"conn"`
	Op   string `json:"op"`           // open | data | close
	Data string `json:"data,omitempty"` // base64
	Err  string `json:"err,omitempty"`
}

type tunnelConn struct {
	nc   net.Conn // 拨号模式下 dial 完成前是 nil（send 队列照常缓冲）
	send chan []byte
	done chan struct{} // closeOnce 收口信号（dial 在途时取消用）
	once   sync.Once
	hub    *tunnelHub
	tunID  string
	connID uint64
}

func (c *tunnelConn) emit(op, data, errStr string) {
	_ = c.hub.enc.Encode(event{Event: "tunnel", Data: tunnelEventData{
		ID: c.tunID, Conn: c.connID, Op: op, Data: data, Err: errStr,
	}})
}

// closeOnce：读循环/写循环/外部 tunnel_close 三路都可能来关，只真正关一次
func (c *tunnelConn) closeOnce(op, errStr string) {
	c.once.Do(func() {
		close(c.send)
		close(c.done)
		if c.nc != nil {
			_ = c.nc.Close()
		}
		c.hub.removeConn(c.tunID, c.connID)
		if op != "" {
			c.emit(op, "", errStr)
		}
	})
}

type tunnel struct {
	ln    net.Listener
	conns map[uint64]*tunnelConn
}

type tunnelHub struct {
	enc      *safeEncoder
	mu       sync.Mutex
	tunnels  map[string]*tunnel
	nextConn uint64
	// 应用侧发起拨号的连接（容器版 -L：本机监听、容器内去拨）——
	// 不挂在任何 listener 下，键为 "规则id:connId"
	dials map[string]*tunnelConn
}

func newTunnelHub(enc *safeEncoder) *tunnelHub {
	return &tunnelHub{enc: enc, tunnels: make(map[string]*tunnel), dials: make(map[string]*tunnelConn)}
}

var errTunnelExists = errors.New("隧道 id 已存在（先 tunnel_close 再开）")

// start：起监听 + accept 循环。监听本身在主循环里做（快），失败直接回错。
func (h *tunnelHub) start(params json.RawMessage) (interface{}, error) {
	var p struct {
		ID         string `json:"id"`
		ListenAddr string `json:"listen_addr"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.ID == "" || p.ListenAddr == "" {
		return nil, errors.New("tunnel_start 需要 id 与 listen_addr")
	}
	ln, err := net.Listen("tcp", p.ListenAddr)
	if err != nil {
		return nil, fmt.Errorf("监听 %s 失败: %w", p.ListenAddr, err)
	}
	h.mu.Lock()
	if _, dup := h.tunnels[p.ID]; dup {
		h.mu.Unlock()
		_ = ln.Close()
		return nil, errTunnelExists
	}
	t := &tunnel{ln: ln, conns: make(map[uint64]*tunnelConn)}
	h.tunnels[p.ID] = t
	h.mu.Unlock()

	go h.acceptLoop(p.ID, t)
	return map[string]interface{}{"listening": true, "addr": ln.Addr().String()}, nil
}

func (h *tunnelHub) acceptLoop(tunID string, t *tunnel) {
	for {
		nc, err := t.ln.Accept()
		if err != nil {
			return // listener 被 close（tunnel_close / stop / 进程退出）
		}
		h.mu.Lock()
		h.nextConn++
		connID := h.nextConn
		c := &tunnelConn{nc: nc, send: make(chan []byte, tunnelSendBufCap), done: make(chan struct{}), hub: h, tunID: tunID, connID: connID}
		t.conns[connID] = c
		h.mu.Unlock()
		c.emit("open", "", "")
		go h.readLoop(c)
		go h.writeLoop(c)
	}
}

// 容器 → 应用：同步编码进 serve 流，应用读得慢这里自然堵住（TCP 背压回传）
func (h *tunnelHub) readLoop(c *tunnelConn) {
	buf := make([]byte, tunnelChunkSize)
	for {
		n, err := c.nc.Read(buf)
		if n > 0 {
			c.emit("data", base64.StdEncoding.EncodeToString(buf[:n]), "")
		}
		if err != nil {
			// EOF 与 reset 对上层都是「这条连接没了」，err 只留作排查线索
			errStr := ""
			if err.Error() != "EOF" {
				errStr = err.Error()
			}
			c.closeOnce("close", errStr)
			return
		}
	}
}

// 应用 → 容器：队列保证单连接内顺序；队列被关停（close 掉 chan）即退出
func (h *tunnelHub) writeLoop(c *tunnelConn) {
	for chunk := range c.send {
		if _, err := c.nc.Write(chunk); err != nil {
			c.closeOnce("close", err.Error())
			return
		}
	}
}

// data：应用侧来的一帧数据。队列满 = 对端不读了还在发 —— 断这条连接保全局
func (h *tunnelHub) data(params json.RawMessage) error {
	var p struct {
		ID   string `json:"id"`
		Conn uint64 `json:"conn"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return err
	}
	raw, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return fmt.Errorf("tunnel_data 的 data 不是合法 base64: %w", err)
	}
	c := h.findConn(p.ID, p.Conn)
	if c == nil {
		return nil // 连接已经没了（对端先关/溢出断开）：晚到的数据帧直接丢
	}
	select {
	case c.send <- raw:
	default:
		c.closeOnce("close", "发送队列溢出（对端不读了），连接断开")
	}
	return nil
}

// closeTunnel：conn=0 停整条隧道（规则删除/重开），否则只断一条连接
func (h *tunnelHub) closeTunnel(params json.RawMessage) error {
	var p struct {
		ID   string `json:"id"`
		Conn uint64 `json:"conn"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.ID == "" {
		return errors.New("tunnel_close 需要 id")
	}
	if p.Conn != 0 {
		if c := h.findConn(p.ID, p.Conn); c != nil {
			c.closeOnce("", "") // 应用方发起的关闭不再回 close 事件（对面就是发起者）
		}
		return nil
	}
	h.mu.Lock()
	t := h.tunnels[p.ID]
	delete(h.tunnels, p.ID)
	// 同规则下应用侧拨号的连接（容器 -L）也一起收 —— 这类规则没有 listener，
	// 不能靠 t==nil 早退把它们漏掉
	prefix := p.ID + ":"
	var conns []*tunnelConn
	if t != nil {
		_ = t.ln.Close()
		for _, c := range t.conns {
			conns = append(conns, c)
		}
	}
	for k, c := range h.dials {
		if strings.HasPrefix(k, prefix) {
			conns = append(conns, c)
			delete(h.dials, k)
		}
	}
	h.mu.Unlock()
	for _, c := range conns {
		c.closeOnce("close", "隧道停止")
	}
	return nil
}

// dial：应用侧发起的拨号（容器版 -L 的数据面）。**异步**：DialTimeout 可能
// 阻塞数秒，同步做会把 serve 主循环（还背着 watch/fs/其他隧道）整个吊住。
// 先占位再拨：拨号在途期间应用来的数据帧进 send 队列缓冲；成败以帧回答
// （成功 open / 失败 close+err）。connId 由应用侧分配（它先有连接后有拨号）。
func (h *tunnelHub) dial(params json.RawMessage) (interface{}, error) {
	var p struct {
		ID     string `json:"id"`
		Conn   uint64 `json:"conn"`
		Target string `json:"target_addr"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.ID == "" || p.Conn == 0 || p.Target == "" {
		return nil, errors.New("tunnel_connect 需要 id、conn 与 target_addr")
	}
	key := fmt.Sprintf("%s:%d", p.ID, p.Conn)
	c := &tunnelConn{send: make(chan []byte, tunnelSendBufCap), done: make(chan struct{}), hub: h, tunID: p.ID, connID: p.Conn}
	h.mu.Lock()
	h.dials[key] = c
	h.mu.Unlock()

	go func() {
		nc, err := net.DialTimeout("tcp", p.Target, 10*time.Second)
		if err != nil {
			c.closeOnce("close", fmt.Sprintf("容器内拨 %s 失败: %v", p.Target, err))
			return
		}
		// 拨号期间应用侧可能已经关了这条连接：nc 直接关，不起泵
		select {
		case <-c.done:
			_ = nc.Close()
			return
		default:
		}
		c.nc = nc
		c.emit("open", "", "")
		go h.readLoop(c)
		go h.writeLoop(c)
	}()
	return map[string]bool{"accepted": true}, nil
}

func (h *tunnelHub) findConn(tunID string, connID uint64) *tunnelConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if t := h.tunnels[tunID]; t != nil {
		if c := t.conns[connID]; c != nil {
			return c
		}
	}
	return h.dials[fmt.Sprintf("%s:%d", tunID, connID)]
}

func (h *tunnelHub) removeConn(tunID string, connID uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if t := h.tunnels[tunID]; t != nil {
		delete(t.conns, connID)
	}
	delete(h.dials, fmt.Sprintf("%s:%d", tunID, connID))
}

// closeAll：stop / stdin 断开（SSH 通道死了）时收口，不留监听
func (h *tunnelHub) closeAll() {
	h.mu.Lock()
	ids := make([]string, 0, len(h.tunnels))
	for id := range h.tunnels {
		ids = append(ids, id)
	}
	dials := make([]*tunnelConn, 0, len(h.dials))
	for _, c := range h.dials {
		dials = append(dials, c)
	}
	h.mu.Unlock()
	for _, id := range ids {
		raw, _ := json.Marshal(map[string]string{"id": id})
		_ = h.closeTunnel(raw)
	}
	for _, c := range dials {
		c.closeOnce("close", "agent 停止")
	}
}

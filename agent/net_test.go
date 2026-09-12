package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecodeHexAddr(t *testing.T) {
	if got := decodeHexAddr("0100007F", false); got != "127.0.0.1" {
		t.Fatalf("ipv4 loopback: %q", got)
	}
	if got := decodeHexAddr("0304A8C0", false); got != "192.168.4.3" {
		t.Fatalf("ipv4 小端: %q", got)
	}
	// ::1（loopback）：前三个 32 位字为 0，末字 01000000
	v6 := decodeHexAddr("00000000000000000000000001000000", true)
	if !strings.HasSuffix(v6, ":1") && !strings.Contains(v6, ":0:0:0:0:0:0:1") {
		t.Fatalf("ipv6 loopback: %q", v6)
	}
}

const tcpFixture = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:08AE 00000000:0000 0A 00000000:00000000 00:00000000 00000000   911        0 115902 1 ffff10cbf5bd5340 100 0 0 10 0
   1: 0304A8C0:0016 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 115903 1 ffff10cbf5bd5341 100 0 0 10 0
   2: 0304A8C0:9C40 5E83A72D:0050 06 00000000:00000000 00:00000000 00000000     0        0 115904 1 ffff10cbf5bd5342 100 0 0 10 0
   3: 坏行
`

func TestParseProcNetFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "tcp")
	if err := os.WriteFile(p, []byte(tcpFixture), 0o644); err != nil {
		t.Fatal(err)
	}
	conns := parseProcNetFile(p, "tcp", false, false)
	if len(conns) != 3 {
		t.Fatalf("应有 3 行（坏行跳过），实得 %d", len(conns))
	}
	if conns[0].State != "LISTEN" || conns[0].LocalPort != 2222 {
		t.Fatalf("首行应为 LISTEN :2222，实得 %+v", conns[0])
	}
	if conns[1].State != "ESTABLISHED" || conns[1].LocalAddr != "192.168.4.3" || conns[1].RemoteAddr != "127.0.0.1" {
		t.Fatalf("次行解析错误: %+v", conns[1])
	}
	if conns[2].State != "TIME_WAIT" || conns[2].RemotePort != 80 {
		t.Fatalf("第三行解析错误: %+v", conns[2])
	}
}

func TestParseProcNetUDP(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "udp")
	_ = os.WriteFile(p, []byte(`  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 99999 1 ffff 100 0 0 10 0
`), 0o644)
	conns := parseProcNetFile(p, "udp", false, true)
	if len(conns) != 1 || conns[0].State != "UNCONN" || conns[0].LocalPort != 53 {
		t.Fatalf("udp 解析错误: %+v", conns)
	}
}

func TestParseProcNetMissing(t *testing.T) {
	if conns := parseProcNetFile("/nonexistent/tcp6", "tcp6", true, false); conns != nil {
		t.Fatalf("文件不存在应返回 nil（容器可能没有 ipv6），实得 %v", conns)
	}
}

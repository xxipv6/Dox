// 连接表（netstat -ano 的 /proc 直读版）：net_conns 方法。
//
// 数据源是只读的 /proc/net/{tcp,tcp6,udp,udp6} + /proc/[pid]/fd 的
// socket:[inode] 反向映射 —— 不依赖 netstat/ss 二进制，distroless 容器里
// 也能出表（容器有自己的 netns，agent 在容器里看到的就是容器的连接）。
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

type netConn struct {
	Proto      string `json:"proto"` // tcp / tcp6 / udp / udp6
	LocalAddr  string `json:"local_addr"`
	LocalPort  int    `json:"local_port"`
	RemoteAddr string `json:"remote_addr"`
	RemotePort int    `json:"remote_port"`
	State      string `json:"state"` // ESTABLISHED / LISTEN / TIME_WAIT …（UDP 无状态给 UNCONN）
	Pid        int    `json:"pid,omitempty"`
	Process    string `json:"process,omitempty"`
}

var tcpStates = map[string]string{
	"01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1",
	"05": "FIN_WAIT2", "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT",
	"09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING",
}

// 结果行数上限：机器上连接爆炸时（爬虫/被扫）也不能把 IPC 帧撑炸
const netConnsCap = 500

// decodeHexAddr：/proc/net/* 的地址是小端十六进制（IPv4 8 位，IPv6 4×8 位）
func decodeHexAddr(h string, v6 bool) string {
	if !v6 {
		if len(h) != 8 {
			return h
		}
		b := make([]int, 4)
		for i := 0; i < 4; i++ {
			v, err := strconv.ParseUint(h[i*2:i*2+2], 16, 8)
			if err != nil {
				return h
			}
			b[i] = int(v)
		}
		return fmt.Sprintf("%d.%d.%d.%d", b[3], b[2], b[1], b[0])
	}
	if len(h) != 32 {
		return h
	}
	// IPv6：4 个 32 位字，每字内部小端（b0 b1 b2 b3 → V = b0|b1<<8|b2<<16|b3<<24；
	// 文本组序是高 16 位在前：b3b2 一组、b1b0 一组）
	var groups []string
	for w := 0; w < 4; w++ {
		word := h[w*8 : w*8+8]
		hi, err1 := strconv.ParseUint(word[6:8]+word[4:6], 16, 16)
		lo, err2 := strconv.ParseUint(word[2:4]+word[0:2], 16, 16)
		if err1 != nil || err2 != nil {
			return h
		}
		groups = append(groups, fmt.Sprintf("%x:%x", hi, lo))
	}
	return strings.Join(groups, ":")
}

func decodeHexPort(p string) int {
	v, _ := strconv.ParseUint(p, 16, 16)
	return int(v)
}

// parseProcNetFile 解析一份 /proc/net/{tcp,tcp6,udp,udp6}
func parseProcNetFile(path, proto string, v6, isUDP bool) []netConn {
	f, err := os.Open(path)
	if err != nil {
		return nil // 没有 ipv6 协议的机器上 tcp6 不存在，正常
	}
	defer f.Close()

	var conns []netConn
	scanner := bufio.NewScanner(f)
	scanner.Scan() // 表头行
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		lp := strings.SplitN(fields[1], ":", 2)
		rp := strings.SplitN(fields[2], ":", 2)
		if len(lp) != 2 || len(rp) != 2 {
			continue
		}
		state := "UNCONN"
		if !isUDP {
			state = tcpStates[fields[3]]
			if state == "" {
				state = fields[3]
			}
		}
		inode, _ := strconv.ParseUint(fields[9], 10, 64)
		conns = append(conns, netConn{
			Proto:      proto,
			LocalAddr:  decodeHexAddr(lp[0], v6),
			LocalPort:  decodeHexPort(lp[1]),
			RemoteAddr: decodeHexAddr(rp[0], v6),
			RemotePort: decodeHexPort(rp[1]),
			State:      state,
			Pid:        int(inode), // 暂存 inode，映射阶段换成 pid
		})
	}
	return conns
}

// socketOwners：扫 /proc/[pid]/fd，建 socket inode → (pid, comm) 映射。
// fd 数量远比连接多，但都是 readlink 一次，千级以内毫秒完成。
func socketOwners() map[uint64]struct {
	pid  int
	comm string
} {
	owners := make(map[uint64]struct {
		pid  int
		comm string
	})
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return owners
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		fds, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
		if err != nil {
			continue // 进程可能刚退出，或没权限（容器里跑别的用户的进程）
		}
		for _, fd := range fds {
			link, err := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", pid, fd.Name()))
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			inode, err := strconv.ParseUint(link[8:len(link)-1], 10, 64)
			if err != nil {
				continue
			}
			if _, seen := owners[inode]; seen {
				continue
			}
			comm, _ := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
			owners[inode] = struct {
				pid  int
				comm string
			}{pid: pid, comm: strings.TrimSpace(string(comm))}
		}
	}
	return owners
}

func netConns(params json.RawMessage) (interface{}, error) {
	_ = params
	var conns []netConn
	conns = append(conns, parseProcNetFile("/proc/net/tcp", "tcp", false, false)...)
	conns = append(conns, parseProcNetFile("/proc/net/tcp6", "tcp6", true, false)...)
	conns = append(conns, parseProcNetFile("/proc/net/udp", "udp", false, true)...)
	conns = append(conns, parseProcNetFile("/proc/net/udp6", "udp6", true, true)...)
	if conns == nil {
		return nil, errors.New("读不到 /proc/net/*（非 Linux？）")
	}

	owners := socketOwners()
	for i := range conns {
		inode := uint64(conns[i].Pid)
		conns[i].Pid = 0
		if o, ok := owners[inode]; ok {
			conns[i].Pid = o.pid
			conns[i].Process = o.comm
		}
	}

	// 排面：活跃连接在前，监听居中，TIME_WAIT 之类收尾；同状态按本地端口
	rank := func(s string) int {
		switch s {
		case "ESTABLISHED":
			return 0
		case "LISTEN":
			return 1
		case "UNCONN":
			return 2
		default:
			return 3
		}
	}
	sort.Slice(conns, func(i, j int) bool {
		if rank(conns[i].State) != rank(conns[j].State) {
			return rank(conns[i].State) < rank(conns[j].State)
		}
		return conns[i].LocalPort < conns[j].LocalPort
	})

	truncated := false
	if len(conns) > netConnsCap {
		conns = conns[:netConnsCap]
		truncated = true
	}
	return map[string]interface{}{"conns": conns, "truncated": truncated}, nil
}

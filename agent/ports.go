// /proc/net/tcp{,6} 的 LISTEN 端口发现与差分推送。
//
// 与主仓 src/main/ssh/procNet.ts 是同一招的 Go 版：内核 socket 表谁都能读，
// agent 的价值在于「常驻」——差分在本地算好，只把变化推回应用，
// 不再每几秒一条 SSH exec 往返。
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// readListening 返回两张表里去重后的 LISTEN（st=0A）端口集合
func readListening() (map[uint16]bool, error) {
	ports := make(map[uint16]bool)
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			// tcp6 不存在（老内核/禁 IPv6）不是错误
			continue
		}
		parseProcNet(bufio.NewScanner(f), ports)
		_ = f.Close()
	}
	if len(ports) == 0 {
		// 两张表都读不到：这不是「没有监听」，是「这台机器没有 /proc」
		if _, err := os.Stat("/proc/net/tcp"); err != nil {
			return nil, err
		}
	}
	return ports, nil
}

// parseProcNet 把一张表里的 LISTEN 端口并入集合（导出给单测）
func parseProcNet(scanner *bufio.Scanner, ports map[uint16]bool) {
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		// 数据行：序号以 ":" 结尾，第 4 列是状态；表头第 1 列是 "sl"
		if len(fields) < 4 || !strings.HasSuffix(fields[0], ":") || fields[0] == "sl" {
			continue
		}
		if fields[3] != "0A" { // 0A = LISTEN
			continue
		}
		parts := strings.Split(fields[1], ":")
		if len(parts) != 2 {
			continue
		}
		port64, err := strconv.ParseUint(parts[1], 16, 32)
		if err != nil || port64 < 1 || port64 > 65535 {
			continue
		}
		ports[uint16(port64)] = true
	}
}

func sortedKeys(m map[uint16]bool) []uint16 {
	out := make([]uint16, 0, len(m))
	for p := range m {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// watchPorts 周期读表，只在集合变化时推事件（含首帧全量）
func watchPorts(intervalMs int, enc *json.Encoder, stop chan struct{}) {
	ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer ticker.Stop()

	var baseline map[uint16]bool
	push := func() {
		cur, err := readListening()
		if err != nil {
			_ = enc.Encode(event{Event: "ports_error", Data: map[string]string{"error": err.Error()}})
			return
		}
		if baseline == nil {
			baseline = cur
			_ = enc.Encode(event{Event: "ports", Data: map[string]interface{}{
				"listening": sortedKeys(cur), "added": sortedKeys(cur), "removed": []uint16{},
			}})
			return
		}
		var added, removed []uint16
		for p := range cur {
			if !baseline[p] {
				added = append(added, p)
			}
		}
		for p := range baseline {
			if !cur[p] {
				removed = append(removed, p)
			}
		}
		if len(added) == 0 && len(removed) == 0 {
			return
		}
		baseline = cur
		sort.Slice(added, func(i, j int) bool { return added[i] < added[j] })
		sort.Slice(removed, func(i, j int) bool { return removed[i] < removed[j] })
		_ = enc.Encode(event{Event: "ports", Data: map[string]interface{}{
			"listening": sortedKeys(cur), "added": added, "removed": removed,
		}})
	}

	push()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			push()
		}
	}
}

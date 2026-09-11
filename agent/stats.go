// 系统状态采集与推送：CPU / 内存 / GPU。
//
// 数据源全是只读的现成接口：/proc/stat（CPU 两次采样差分）、
// /proc/meminfo（MemTotal - MemAvailable）、nvidia-smi（存在才报 GPU，
// 启动时 LookPath 一次，没有显卡的机器这项整个省略）。
// 不引入任何依赖，psutil 那种跨平台库对一个 2MB 的静态二进制来说太重。
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// safeEncoder：watch 协程与 serve 主循环共用同一个 stdout 编码器，
// json.Encoder 不是协程安全的 —— 两个事件帧交错写出去就是一行坏 JSON，
// 对端解析失败静默丢弃，表现为「偶发收不到推送」，极难查。
type safeEncoder struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func (s *safeEncoder) Encode(v interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enc.Encode(v)
}

type gpuStat struct {
	Name        string `json:"name"`
	UtilPercent int    `json:"util_percent"`
	MemUsedMB   int    `json:"mem_used_mb"`
	MemTotalMB  int    `json:"mem_total_mb"`
}

type statsPayload struct {
	CPUPercent float64   `json:"cpu_percent"`
	MemTotalMB int       `json:"mem_total_mb"`
	MemUsedMB  int       `json:"mem_used_mb"`
	Gpus       []gpuStat `json:"gpus,omitempty"`
}

// cpuTimes：/proc/stat 第一行（聚合行）的 idle 与 total jiffies
type cpuTimes struct {
	idle  uint64
	total uint64
}

// parseCPULine 解析 "cpu  user nice system idle iowait irq softirq steal …"
func parseCPULine(line string) (cpuTimes, bool) {
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuTimes{}, false
	}
	var t cpuTimes
	for i, f := range fields[1:] {
		v, err := strconv.ParseUint(f, 10, 64)
		if err != nil {
			return cpuTimes{}, false
		}
		t.total += v
		if i == 3 { // idle（iowait 也算闲，但主流监控口径只算 idle，保持一致）
			t.idle = v
		}
	}
	return t, true
}

func readCPUTimes(r io.Reader) (cpuTimes, error) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		if t, ok := parseCPULine(scanner.Text()); ok {
			return t, nil
		}
	}
	return cpuTimes{}, io.ErrUnexpectedEOF
}

// cpuPercent：两次采样间的使用率；total 不增长（时钟回拨/计数复位）返回 0
func cpuPercent(prev, cur cpuTimes) float64 {
	// 先比大小再做减法：uint64 反向相减会下溢成一个巨大正数
	if cur.total <= prev.total || cur.idle < prev.idle {
		return 0
	}
	dTotal := cur.total - prev.total
	dIdle := cur.idle - prev.idle
	p := float64(dTotal-dIdle) / float64(dTotal) * 100
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// parseMemInfo 从 /proc/meminfo 取 MemTotal 与 MemAvailable（kB → MB）
func parseMemInfo(r io.Reader) (totalMB, usedMB int, err error) {
	var totalKB, availKB int64
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		v, perr := strconv.ParseInt(fields[1], 10, 64)
		if perr != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			totalKB = v
		case "MemAvailable:":
			availKB = v
		}
	}
	if totalKB <= 0 {
		return 0, 0, io.ErrUnexpectedEOF
	}
	used := totalKB - availKB
	if used < 0 {
		used = 0
	}
	return int(totalKB / 1024), int(used / 1024), nil
}

// parseNvidiaCSV 解析 nvidia-smi --format=csv,noheader,nounits 的输出：
// "NVIDIA A100-SXM4-40GB, 35, 1024, 40960"。N/A 字段（老卡无利用率计）按 0 计。
func parseNvidiaCSV(out string) []gpuStat {
	var gpus []gpuStat
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 4 {
			continue
		}
		atoi := func(s string) int {
			v, _ := strconv.Atoi(strings.TrimSpace(s))
			return v
		}
		gpus = append(gpus, gpuStat{
			Name:        strings.TrimSpace(parts[0]),
			UtilPercent: atoi(parts[1]),
			MemUsedMB:   atoi(parts[2]),
			MemTotalMB:  atoi(parts[3]),
		})
	}
	return gpus
}

// queryGPUs：没有 nvidia-smi（绝大多数机器）返回 nil，调用方整个省略 GPU 字段
func queryGPUs(nvidiaSmi string) []gpuStat {
	if nvidiaSmi == "" {
		return nil
	}
	out, err := exec.Command(nvidiaSmi,
		"--query-gpu=name,utilization.gpu,memory.used,memory.total",
		"--format=csv,noheader,nounits",
	).Output()
	if err != nil {
		return nil
	}
	return parseNvidiaCSV(string(out))
}

// watchStats 周期推送系统状态。首帧用 200ms 短采样让 UI 尽快有数，
// 之后每个 tick 与上一帧差分。采集失败（非 Linux）推 stats_error 并退出。
func watchStats(intervalMs int, enc *safeEncoder, stop chan struct{}) {
	nvidiaSmi, _ := exec.LookPath("nvidia-smi")

	f0, err := os.Open("/proc/stat")
	if err != nil {
		_ = enc.Encode(event{Event: "stats_error", Data: map[string]string{"error": err.Error()}})
		return
	}
	prev, err := readCPUTimes(f0)
	_ = f0.Close()
	if err != nil {
		_ = enc.Encode(event{Event: "stats_error", Data: map[string]string{"error": err.Error()}})
		return
	}

	push := func() bool {
		f, err := os.Open("/proc/stat")
		if err != nil {
			_ = enc.Encode(event{Event: "stats_error", Data: map[string]string{"error": err.Error()}})
			return false
		}
		cur, err := readCPUTimes(f)
		_ = f.Close()
		if err != nil {
			return true // 读坏了跳过这帧，不致命
		}
		mf, err := os.Open("/proc/meminfo")
		if err != nil {
			return true
		}
		totalMB, usedMB, err := parseMemInfo(mf)
		_ = mf.Close()
		if err != nil {
			return true
		}
		_ = enc.Encode(event{Event: "stats", Data: statsPayload{
			CPUPercent: cpuPercent(prev, cur),
			MemTotalMB: totalMB,
			MemUsedMB:  usedMB,
			Gpus:       queryGPUs(nvidiaSmi),
		}})
		prev = cur
		return true
	}

	// 首帧短采样
	select {
	case <-stop:
		return
	case <-time.After(200 * time.Millisecond):
		if !push() {
			return
		}
	}

	ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if !push() {
				return
			}
		}
	}
}

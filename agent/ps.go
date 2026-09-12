// ps_list / ps_kill：直读 /proc 的进程表，不依赖 ps 二进制（distroless 容器也能列）。
//
// CPU% 用两次采样差分（与 stats.go 的系统级 CPU 同一口径）：先记一轮
// 每进程 jiffies 与系统总 jiffies，睡 sample_ms 再记一轮，差值相除。
// 进程在两次采样之间消失是常态（短命令），逐 pid 忽略错误即可。
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type procInfo struct {
	Pid        int     `json:"pid"`
	Ppid       int     `json:"ppid"`
	User       string  `json:"user"`
	RssBytes   int64   `json:"rss_bytes"`
	CPUPercent float64 `json:"cpu_percent"`
	MemPercent float64 `json:"mem_percent"`
	Command    string  `json:"command"`
}

// procSample：一次采样里一个进程需要的全部字段（uid 与命令在第二轮假定不变）
type procSample struct {
	pid     int
	ppid    int
	utime   uint64
	stime   uint64
	rss     int64
	uid     string
	command string
}

// parseProcStat 解析 /proc/<pid>/stat。
// comm 在括号里且可以含空格甚至括号本身（线程名 "（lunarlens）" 这类），
// 所以不能用 Fields 直接切：先找最后一个 ')'，后面的字段从 state(3) 开始数。
func parseProcStat(content string) (pid, ppid int, utime, stime uint64, rssPages int64, comm string, ok bool) {
	open := strings.IndexByte(content, '(')
	closeIdx := strings.LastIndexByte(content, ')')
	if open < 0 || closeIdx < open {
		return 0, 0, 0, 0, 0, "", false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(content[:open]))
	if err != nil {
		return 0, 0, 0, 0, 0, "", false
	}
	comm = content[open+1 : closeIdx]
	rest := strings.Fields(content[closeIdx+1:])
	// rest[0]=state(3) rest[1]=ppid(4) … rest[11]=utime(14) rest[12]=stime(15) … rest[21]=rss(24，页)
	if len(rest) < 22 {
		return 0, 0, 0, 0, 0, "", false
	}
	ppid, _ = strconv.Atoi(rest[1])
	utime, _ = strconv.ParseUint(rest[11], 10, 64)
	stime, _ = strconv.ParseUint(rest[12], 10, 64)
	rssPages, _ = strconv.ParseInt(rest[21], 10, 64)
	return pid, ppid, utime, stime, rssPages, comm, true
}

// readProcSample 读一个 pid 的 stat/status/cmdline；进程已走返回 ok=false
func readProcSample(pid int) (procSample, bool) {
	var s procSample
	statRaw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return s, false
	}
	spid, ppid, utime, stime, _, comm, ok := parseProcStat(string(statRaw))
	if !ok || spid != pid {
		return s, false
	}
	s.pid, s.ppid, s.utime, s.stime = pid, ppid, utime, stime

	// status：Uid（第一列 real uid）与 VmRSS（kB）
	if statusRaw, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid)); err == nil {
		for _, line := range strings.Split(string(statusRaw), "\n") {
			if strings.HasPrefix(line, "Uid:") {
				if f := strings.Fields(line); len(f) >= 2 {
					s.uid = f[1]
				}
			} else if strings.HasPrefix(line, "VmRSS:") {
				if f := strings.Fields(line); len(f) >= 2 {
					kb, _ := strconv.ParseInt(f[1], 10, 64)
					s.rss = kb * 1024
				}
			}
		}
	}

	// cmdline 是 NUL 分隔；内核线程为空，退回 [comm]
	if cmd := readProcCmdline(pid); cmd != "" {
		s.command = cmd
	}
	if s.command == "" {
		s.command = "[" + comm + "]"
	}
	return s, true
}

// readProcCmdline 读完整命令行（NUL 分隔 → 空格）；读不到返回空串
func readProcCmdline(pid int) string {
	cmdRaw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	return strings.Join(strings.Fields(strings.ReplaceAll(string(cmdRaw), "\x00", " ")), " ")
}

// readProcSampleLight 只读 stat（utime/stime + rss 页数 + comm）。
// watch_stats 每帧全量采样走它：每进程省掉 status/cmdline 两次文件读
// （千级进程的宿主机上这是帧成本的大头），完整 cmdline 只在 top 榜
// 点名后补读。
func readProcSampleLight(pid int) (procSample, bool) {
	var s procSample
	statRaw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return s, false
	}
	spid, ppid, utime, stime, rssPages, comm, ok := parseProcStat(string(statRaw))
	if !ok || spid != pid {
		return s, false
	}
	s.pid, s.ppid, s.utime, s.stime = pid, ppid, utime, stime
	if rssPages > 0 {
		s.rss = rssPages * int64(os.Getpagesize())
	}
	s.command = "[" + comm + "]"
	return s, true
}

// passwdMap：uid → 用户名。distroless 容器可能没有 /etc/passwd —— 那就显示数字 uid。
func passwdMap() map[string]string {
	m := map[string]string{}
	raw, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return m
	}
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.Split(line, ":")
		if len(f) >= 3 {
			m[f[2]] = f[0]
		}
	}
	return m
}

func listPids() ([]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, e := range entries {
		if pid, err := strconv.Atoi(e.Name()); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}

func readTotalCPUTimes() (cpuTimes, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}, err
	}
	defer f.Close()
	return readCPUTimes(f)
}

// readMemTotalBytes 读 /proc/meminfo 的 MemTotal（parseMemInfo 返回 MB，换回字节）
func readMemTotalBytes() (float64, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	totalMB, _, err := parseMemInfo(f)
	return float64(totalMB) * 1024 * 1024, err
}

func psList(params json.RawMessage) (interface{}, error) {
	var p struct {
		SampleMs int `json:"sample_ms"`
	}
	_ = json.Unmarshal(params, &p)
	if p.SampleMs <= 0 {
		p.SampleMs = 300
	}
	if p.SampleMs > 5000 {
		p.SampleMs = 5000
	}

	// 总 jiffies 基准必须把两轮全量采样**包在里面**，而不是只包中间的 sleep：
	// 逐进程差分窗口是「第一轮读到它 → 第二轮读到它」（含两轮循环本身的耗时），
	// 基准若只盖 sleep，慢机器上所有进程的 CPU% 会被成比例放大
	//（实测 1822 进程的机器上 agent 自己被报成 63%，真实值 21%）
	totalBefore, err := readTotalCPUTimes()
	if err != nil {
		return nil, err
	}
	pids, err := listPids()
	if err != nil {
		return nil, err
	}
	first := map[int]procSample{}
	for _, pid := range pids {
		if s, ok := readProcSample(pid); ok {
			first[pid] = s
		}
	}

	time.Sleep(time.Duration(p.SampleMs) * time.Millisecond)

	second := map[int]procSample{}
	for _, pid := range pids {
		if _, seen := first[pid]; !seen {
			continue // 第一轮之后才出生的进程没有差分基准，下轮再见
		}
		if s, ok := readProcSampleLight(pid); ok { // 第二轮只要差分字段（utime/stime/rss），status/cmdline 白读两次是浪费
			second[pid] = s
		}
	}
	totalAfter, err := readTotalCPUTimes()
	if err != nil {
		return nil, err
	}
	totalDelta := float64(totalAfter.total - totalBefore.total)
	if totalDelta <= 0 {
		totalDelta = 1
	}
	ncpu := float64(runtime.NumCPU())

	memTotalBytes, memErr := readMemTotalBytes()
	passwd := passwdMap()

	var out []procInfo
	for _, pid := range pids {
		before, seen := first[pid]
		if !seen {
			continue
		}
		after, ok := second[pid]
		if !ok {
			continue // 采样间隙退出了
		}
		// 轻量采样不带 uid/command：沿用第一轮的（采样窗内不会变）
		after.uid, after.command = before.uid, before.command
		user := passwd[after.uid]
		if user == "" {
			user = after.uid
		}
		info := procInfo{
			Pid:        pid,
			Ppid:       after.ppid,
			User:       user,
			RssBytes:   after.rss,
			CPUPercent: float64(after.utime+after.stime-before.utime-before.stime) / totalDelta * ncpu * 100,
			Command:    after.command,
		}
		if memErr == nil && memTotalBytes > 0 {
			info.MemPercent = float64(after.rss) / memTotalBytes * 100
		}
		out = append(out, info)
	}
	if out == nil {
		out = []procInfo{}
	}
	return map[string]interface{}{"processes": out}, nil
}

// ---- top 进程（watch_stats 帧的「谁在吃 CPU」字段）----

type topProc struct {
	Pid        int     `json:"pid"`
	Command    string  `json:"command"`
	CPUPercent float64 `json:"cpu_percent"`
	MemPercent float64 `json:"mem_percent"`
}

// sampleProcTimes 给所有活进程记一轮 jiffies（watch_stats 每帧调用，不做两次采样差分——
// 帧与帧之间天然就是两次采样）
func sampleProcTimes() map[int]procSample {
	out := map[int]procSample{}
	pids, err := listPids()
	if err != nil {
		return out
	}
	for _, pid := range pids {
		if s, ok := readProcSampleLight(pid); ok {
			out[pid] = s
		}
	}
	return out
}

// topProcs：两帧之间的 CPU 差分 top N。首轮（无基准）返回空。
func topProcs(prev, cur map[int]procSample, totalDelta float64, memTotalBytes float64, n int) []topProc {
	if totalDelta <= 0 {
		return nil
	}
	ncpu := float64(runtime.NumCPU())
	var all []topProc
	for pid, after := range cur {
		before, seen := prev[pid]
		if !seen {
			continue // 帧间出生的进程没有差分基准，下帧再说
		}
		p := float64(after.utime+after.stime-before.utime-before.stime) / totalDelta * ncpu * 100
		tp := topProc{Pid: pid, Command: after.command, CPUPercent: p}
		if memTotalBytes > 0 {
			tp.MemPercent = float64(after.rss) / memTotalBytes * 100
		}
		all = append(all, tp)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].CPUPercent > all[j].CPUPercent })
	if len(all) > n {
		all = all[:n]
	}
	// 只有上榜的几个值得补读完整 cmdline（全量读每帧太费）
	for i := range all {
		if cmd := readProcCmdline(all[i].Pid); cmd != "" {
			all[i].Command = cmd
		}
	}
	return all
}

// ps_kill 的信号白名单：TERM 先礼后兵，KILL 兜底。其余信号（STOP/CONT…）
// 对「结束任务」这个场景没有正当用途，不开口子。
var allowedSignals = map[int]bool{int(syscall.SIGTERM): true, int(syscall.SIGKILL): true}

func psKill(params json.RawMessage) (interface{}, error) {
	var p struct {
		Pid    int `json:"pid"`
		Signal int `json:"signal"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, errors.New("ps_kill 需要 pid 与 signal")
	}
	if !allowedSignals[p.Signal] {
		return nil, errors.New("只允许 SIGTERM(15) / SIGKILL(9)")
	}
	if p.Pid < 2 {
		return nil, errors.New("不允许动 init/kernel 进程")
	}
	if p.Pid == os.Getpid() {
		return nil, errors.New("不允许结束 dox-agent 自己")
	}
	if err := syscall.Kill(p.Pid, syscall.Signal(p.Signal)); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

package main

import (
	"encoding/json"
	"os"
	"runtime"
	"testing"
)

func TestParseProcStat(t *testing.T) {
	// 真实现：/proc/1/stat 形状
	line := "1234 (nginx) S 1 1234 1234 0 -1 4194304 100 0 0 0 42 17 0 0 20 0 1 0 100 200 300"
	pid, ppid, utime, stime, comm, ok := parseProcStat(line)
	if !ok || pid != 1234 || ppid != 1 || utime != 42 || stime != 17 || comm != "nginx" {
		t.Fatalf("parseProcStat basic: pid=%d ppid=%d utime=%d stime=%d comm=%q ok=%v", pid, ppid, utime, stime, comm, ok)
	}
}

func TestParseProcStatCommWithSpacesAndParens(t *testing.T) {
	// comm 可以含空格甚至括号：用最后一个 ')' 分界才不会切错
	line := "55 (weird (name) x) S 9 55 55 0 -1 4194304 1 2 3 4 500 600"
	pid, ppid, utime, stime, comm, ok := parseProcStat(line)
	if !ok || pid != 55 || ppid != 9 || utime != 500 || stime != 600 || comm != "weird (name) x" {
		t.Fatalf("parseProcStat weird comm: %d %d %d %d %q %v", pid, ppid, utime, stime, comm, ok)
	}
}

func TestParseProcStatGarbage(t *testing.T) {
	if _, _, _, _, _, ok := parseProcStat("not a stat line"); ok {
		t.Fatal("垃圾输入必须判失败")
	}
	if _, _, _, _, _, ok := parseProcStat(""); ok {
		t.Fatal("空输入必须判失败")
	}
}

func killParams(pid, signal int) json.RawMessage {
	raw, _ := json.Marshal(map[string]int{"pid": pid, "signal": signal})
	return raw
}

func TestPsKillGuards(t *testing.T) {
	// 白名单外的信号（SIGSTOP 等）直接拒
	if _, err := psKill(killParams(99999, 19)); err == nil {
		t.Fatal("白名单外的信号必须拒绝")
	}
	// init/kernel
	if _, err := psKill(killParams(1, 15)); err == nil {
		t.Fatal("pid<2 必须拒绝")
	}
	// agent 自己
	if _, err := psKill(killParams(os.Getpid(), 15)); err == nil {
		t.Fatal("不允许 kill agent 自己")
	}
	// 不存在的 pid：syscall 报错（ESRCH），不能是 nil
	if _, err := psKill(killParams(1<<30, 15)); err == nil {
		t.Fatal("不存在的 pid 应返回错误")
	}
}

func TestTopProcs(t *testing.T) {
	// 两帧差分：pid 100 涨了 50 jiffies，pid 200 涨了 10，pid 300 是新出生的（无基准）
	prev := map[int]procSample{
		100: {pid: 100, utime: 100, stime: 0, command: "ffmpeg"},
		200: {pid: 200, utime: 500, stime: 0, command: "sshd"},
	}
	cur := map[int]procSample{
		100: {pid: 100, utime: 150, stime: 0, command: "ffmpeg", rss: 1024 * 1024 * 512},
		200: {pid: 200, utime: 510, stime: 0, command: "sshd", rss: 1024 * 1024 * 10},
		300: {pid: 300, utime: 999, stime: 0, command: "new-proc"},
	}
	// totalDelta=100 jiffies：ffmpeg 涨 50 → 50%×核数、sshd 涨 10 → 10%×核数
	ncpu := float64(runtime.NumCPU())
	top := topProcs(prev, cur, 100, 1024*1024*1024, 3)
	if len(top) != 2 {
		t.Fatalf("新进程无基准不该出现: %+v", top)
	}
	if top[0].Pid != 100 || top[0].CPUPercent != 50*ncpu {
		t.Fatalf("top1 应为 ffmpeg 50%%×核数: %+v", top[0])
	}
	if top[1].Pid != 200 || top[1].CPUPercent != 10*ncpu {
		t.Fatalf("top2 应为 sshd 10%%×核数: %+v", top[1])
	}
	if top[0].MemPercent != 50 {
		t.Fatalf("mem%% 应为 50: %+v", top[0])
	}
	// n=1 截断
	if len(topProcs(prev, cur, 100, 0, 1)) != 1 {
		t.Fatal("n 截断不生效")
	}
	// 无基准（首轮）/ totalDelta=0 → 空
	if got := topProcs(nil, cur, 0, 0, 3); len(got) != 0 {
		t.Fatalf("totalDelta=0 应为空: %+v", got)
	}
}

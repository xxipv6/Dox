package main

import (
	"strings"
	"testing"
)

func TestParseCPULine(t *testing.T) {
	// 真实 /proc/stat 首行形状（user nice system idle iowait irq softirq steal …）
	line := "cpu  100 0 200 800 50 0 10 0 0 0"
	ct, ok := parseCPULine(line)
	if !ok {
		t.Fatal("聚合行没解析出来")
	}
	if ct.idle != 800 {
		t.Errorf("idle = %d, 期望 800", ct.idle)
	}
	if ct.total != 100+200+800+50+10 {
		t.Errorf("total = %d, 期望 %d", ct.total, 1160)
	}
	if _, ok := parseCPULine("cpu0  1 2 3 4 5 6 7 8"); ok {
		t.Error("单核行（cpu0）不该被当聚合行")
	}
	if _, ok := parseCPULine("intr 12345"); ok {
		t.Error("非 cpu 行不该解析成功")
	}
}

func TestCPUPercent(t *testing.T) {
	prev := cpuTimes{idle: 800, total: 1160}
	cur := cpuTimes{idle: 900, total: 1360} // 200 tick 里 100 闲 → 50%
	if p := cpuPercent(prev, cur); p < 49.9 || p > 50.1 {
		t.Errorf("cpuPercent = %v, 期望 ~50", p)
	}
	if p := cpuPercent(prev, prev); p != 0 {
		t.Errorf("无增量应得 0, 实际 %v", p)
	}
	// 计数复位（total 变负差）不炸、不给出负值
	reset := cpuTimes{idle: 10, total: 20}
	if p := cpuPercent(prev, reset); p != 0 {
		t.Errorf("计数复位数应得 0, 实际 %v", p)
	}
}

func TestParseMemInfo(t *testing.T) {
	data := `MemTotal:       16384256 kB
MemFree:         8192000 kB
MemAvailable:   12288000 kB
Buffers:          512000 kB
`
	total, used, err := parseMemInfo(strings.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if total != 16000 {
		t.Errorf("total = %d MB, 期望 16004 附近的 16000", total)
	}
	// used = total - available = 16384256 - 12288000 = 4096256 kB = 4000 MB
	if used != 4000 {
		t.Errorf("used = %d MB, 期望 4000", used)
	}
	if _, _, err := parseMemInfo(strings.NewReader("Buffers: 1 kB\n")); err == nil {
		t.Error("缺 MemTotal 应报错")
	}
}

func TestParseNvidiaCSV(t *testing.T) {
	out := `NVIDIA A100-SXM4-40GB, 35, 1024, 40960
NVIDIA A100-SXM4-40GB, N/A, 2048, 40960
`
	gpus := parseNvidiaCSV(out)
	if len(gpus) != 2 {
		t.Fatalf("解析出 %d 张卡, 期望 2", len(gpus))
	}
	if gpus[0].UtilPercent != 35 || gpus[0].MemUsedMB != 1024 || gpus[0].MemTotalMB != 40960 {
		t.Errorf("卡0 字段错: %+v", gpus[0])
	}
	if gpus[1].UtilPercent != 0 {
		t.Errorf("N/A 利用率应按 0 计, 实际 %d", gpus[1].UtilPercent)
	}
	if gpus := parseNvidiaCSV(""); gpus != nil {
		t.Errorf("空输出应得 nil, 实际 %v", gpus)
	}
}

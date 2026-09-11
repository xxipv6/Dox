package main

import (
	"encoding/json"
	"os"
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

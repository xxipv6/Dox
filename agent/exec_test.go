package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestExecEcho(t *testing.T) {
	raw, _ := json.Marshal(map[string]interface{}{"argv": []string{"echo", "hi"}})
	r, err := execOnce(raw)
	if err != nil {
		t.Fatal(err)
	}
	m := r.(map[string]interface{})
	if m["exit_code"] != 0 || strings.TrimSpace(m["stdout"].(string)) != "hi" {
		t.Fatalf("echo: %+v", m)
	}
}

func TestExecExitCode(t *testing.T) {
	raw, _ := json.Marshal(map[string]interface{}{"argv": []string{"false"}})
	r, err := execOnce(raw)
	if err != nil {
		t.Fatal(err)
	}
	if r.(map[string]interface{})["exit_code"] != 1 {
		t.Fatalf("false 应返回 exit 1: %+v", r)
	}
}

func TestExecTimeout(t *testing.T) {
	raw, _ := json.Marshal(map[string]interface{}{"argv": []string{"sleep", "5"}, "timeout_ms": 200})
	start := time.Now()
	r, err := execOnce(raw)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("超时没有按时收回")
	}
	m := r.(map[string]interface{})
	if m["timed_out"] != true {
		t.Fatalf("应标记 timed_out: %+v", m)
	}
}

func TestExecMissingBinary(t *testing.T) {
	raw, _ := json.Marshal(map[string]interface{}{"argv": []string{"/no/such/binary"}})
	if _, err := execOnce(raw); err == nil {
		t.Fatal("二进制不存在应返回错误")
	}
}

func TestExecArgvRequired(t *testing.T) {
	if _, err := execOnce(json.RawMessage(`{}`)); err == nil {
		t.Fatal("空 argv 必须拒绝")
	}
}

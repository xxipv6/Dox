// dox-agent：跑在远端的轻量助手（opt-in 安装，用户显式触发才会被推上去）。
//
// 传输即标准输入输出：应用经 SSH exec 通道启动 `dox-agent serve`，
// 协议是换行分隔的 JSON（NDJSON）——不开端口、不动防火墙、不额外认证，
// SSH 会话就是全部权限边界。
//
// 子命令：
//
//	version  打印一行 JSON 版本信息（安装校验用）
//	serve    进入请求/事件循环（hello / watch_ports / stop）
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// version 由构建管线注入默认值；ldflags -X main.version=x.y.z 可覆盖
var version = "0.6.8"

type request struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type response struct {
	ID     int         `json:"id"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

type event struct {
	Event string      `json:"event"`
	Data  interface{} `json:"data"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dox-agent <version|serve>")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version":
		// 单行 JSON：安装流程据此确认落盘的二进制能跑、版本对得上
		fmt.Printf(`{"agent":"dox-agent","version":%q}`+"\n", version)
	case "serve":
		if err := serve(); err != nil {
			fmt.Fprintln(os.Stderr, "serve:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown subcommand:", os.Args[1])
		os.Exit(2)
	}
}

// writeCallResult：一次性调用方法的统一回包（成功 result / 失败 error）
func writeCallResult(enc *safeEncoder, id int, result interface{}, err error) {
	if err != nil {
		_ = enc.Encode(response{ID: id, Error: err.Error()})
	} else {
		_ = enc.Encode(response{ID: id, Result: result})
	}
}

func serve() error {
	// stdin 可能被塞入大请求（未来传文件），缓冲给宽一点
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	// watch 协程与主循环共用一个编码器：必须加锁（见 stats.go safeEncoder）
	enc := &safeEncoder{enc: json.NewEncoder(os.Stdout)}

	// watch_ports / watch_stats 各有停止信号：stop 或 stdin 关闭都收
	stopPorts := make(chan struct{})
	portsRunning := false
	stopStats := make(chan struct{})
	statsRunning := false
	var fsWG sync.WaitGroup
	// 文件请求来自传输窗口和多个面板，不能无限制地创建 goroutine。
	// 8 个并发足够填满 SSH 窗口，同时避免 fs_du/archive 与分块读写一起
	// 把远端磁盘和内存打满；超出的请求在这里排队，响应仍按 id 对应。
	fsSlots := make(chan struct{}, 8)

	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			// 坏行不致命：协议对端是自家应用，记一笔继续跑
			continue
		}
		switch req.Method {
		case "hello":
			_ = enc.Encode(response{ID: req.ID, Result: map[string]interface{}{
				"agent":   "dox-agent",
				"version": version,
				"pid":     os.Getpid(),
			}})
		case "watch_ports":
			var p struct {
				IntervalMs int `json:"interval_ms"`
			}
			_ = json.Unmarshal(req.Params, &p)
			if p.IntervalMs <= 0 {
				p.IntervalMs = 3000
			}
			if !portsRunning {
				portsRunning = true
				go watchPorts(p.IntervalMs, enc, stopPorts)
			}
			_ = enc.Encode(response{ID: req.ID, Result: map[string]bool{"watching": true}})
		case "watch_stats":
			var p struct {
				IntervalMs int `json:"interval_ms"`
			}
			_ = json.Unmarshal(req.Params, &p)
			if p.IntervalMs <= 0 {
				p.IntervalMs = 3000
			}
			if !statsRunning {
				statsRunning = true
				go watchStats(p.IntervalMs, enc, stopStats)
			}
			_ = enc.Encode(response{ID: req.ID, Result: map[string]bool{"watching": true}})
		case "stop":
			if portsRunning {
				close(stopPorts)
			}
			if statsRunning {
				close(stopStats)
			}
			// 等待异步文件请求完成再退出，避免 stop 抢在 fs_write_commit /
			// 回包之前执行，调用方收到一个无响应的 pending 请求。
			fsWG.Wait()
			_ = enc.Encode(response{ID: req.ID, Result: map[string]bool{"bye": true}})
			return nil
		default:
			// fs_* 可能包含磁盘扫描或大块读写。放到独立 goroutine，
			// 让请求循环继续接收后续分块；否则一个 fs_du/读块会把
			// watch_stats、取消和其他传输请求全部排在后面。safeEncoder
			// 负责并发回包的原子性，响应由 id 与调用方对应。
			if isFSMethod(req.Method) {
				fsWG.Add(1)
				go func(r request) {
					defer fsWG.Done()
					fsSlots <- struct{}{}
					defer func() { <-fsSlots }()
					result, _, err := dispatchFS(r.Method, r.Params)
					if err != nil {
						_ = enc.Encode(response{ID: r.ID, Error: err.Error()})
					} else {
						_ = enc.Encode(response{ID: r.ID, Result: result})
					}
				}(req)
			} else {
				switch req.Method {
				case "ps_list":
					r, err := psList(req.Params)
					writeCallResult(enc, req.ID, r, err)
				case "ps_kill":
					r, err := psKill(req.Params)
					writeCallResult(enc, req.ID, r, err)
				case "exec":
					r, err := execOnce(req.Params)
					writeCallResult(enc, req.ID, r, err)
				case "net_conns":
					r, err := netConns(req.Params)
					writeCallResult(enc, req.ID, r, err)
				default:
					_ = enc.Encode(response{ID: req.ID, Error: "unknown method: " + req.Method})
				}
			}
		}
	}
	// stdin 关闭 = SSH 通道断了：agent 没有存在的意义，跟着退出
	return scanner.Err()
}

// isFSMethod 与 dispatchFS 保持同一份方法集合。将 fs 请求异步化后，
// 未知方法仍在主循环内立即返回错误，避免把协议拼写错误静默吞掉。
func isFSMethod(method string) bool {
	switch method {
	case "fs_list", "fs_stat", "fs_read", "fs_write", "fs_mkdir", "fs_rename", "fs_delete",
		"fs_archive", "fs_usage", "fs_du", "fs_read_chunk", "fs_write_begin", "fs_write_chunk",
		"fs_write_commit", "fs_write_abort":
		return true
	default:
		return false
	}
}

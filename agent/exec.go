// exec：跑一次性命令并收集结果（快捷命令片段「静默执行」的承载）。
//
// argv 直接进 exec.CommandContext —— **不经 shell**（distroless 容器没有 sh），
// 也就没有命令注入面；需要管道/重定向/通配符的片段请用「发送到终端」。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"time"
)

const (
	execDefaultTimeoutMs = 30_000
	execMaxTimeoutMs     = 120_000
	execMaxOutputBytes   = 64 * 1024
)

// cappedBuffer：写满上限后继续吞但不再存（进程不停，输出只截断）
type cappedBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	remain := c.max - c.buf.Len()
	if remain > 0 {
		if len(p) > remain {
			c.buf.Write(p[:remain])
			c.truncated = true
		} else {
			c.buf.Write(p)
		}
	} else {
		c.truncated = true
	}
	return len(p), nil
}

func execOnce(params json.RawMessage) (interface{}, error) {
	var p struct {
		Argv      []string `json:"argv"`
		TimeoutMs int      `json:"timeout_ms"`
	}
	if err := json.Unmarshal(params, &p); err != nil || len(p.Argv) == 0 {
		return nil, errors.New("exec 需要 argv（不经 shell 的argv数组）")
	}
	if p.TimeoutMs <= 0 {
		p.TimeoutMs = execDefaultTimeoutMs
	}
	if p.TimeoutMs > execMaxTimeoutMs {
		p.TimeoutMs = execMaxTimeoutMs
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(p.TimeoutMs)*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, p.Argv[0], p.Argv[1:]...)
	stdout := &cappedBuffer{max: execMaxOutputBytes}
	stderr := &cappedBuffer{max: execMaxOutputBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	runErr := cmd.Run()
	timedOut := ctx.Err() == context.DeadlineExceeded

	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else if timedOut {
			exitCode = -1
		} else {
			// 命令压根没跑起来（不存在/无权限）——这才是协议级错误
			return nil, runErr
		}
	}

	return map[string]interface{}{
		"exit_code": exitCode,
		"stdout":    stdout.buf.String(),
		"stderr":    stderr.buf.String(),
		"timed_out": timedOut,
		"truncated": stdout.truncated || stderr.truncated,
	}, nil
}

// 目录变更监听（Linux inotify，零依赖 —— syscall 包自带 Inotify* 全家桶）。
//
// 语义刻意做窄：调用方给「看得见的目录」全量集合（browse 的 cwd + 树已展开
// 目录），这里整组替换（幂等），变更事件只报「哪个目录变了」（不带文件名 ——
// 渲染层反正要重列整个目录）。事件 300ms 合并一帧：构建工具一秒写几百个
// 文件也只会触发一两次刷新。
//
// inotify 的已知边界（与 VS Code 相同，不算回归）：
//   - NFS 挂载点上别的机器发起的写入看不到（本机终端写的都能看到）；
//   - 非递归：子目录里的变化只报子目录自己（在它也被盯的前提下）。
package main

import (
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// 值得刷新目录列表的事件：新建/删除/移动/写毕/属性变更
const fsWatchMask = syscall.IN_CREATE | syscall.IN_DELETE |
	syscall.IN_MOVED_FROM | syscall.IN_MOVED_TO |
	syscall.IN_CLOSE_WRITE | syscall.IN_ATTRIB |
	syscall.IN_DELETE_SELF | syscall.IN_MOVE_SELF

const fsWatchFlushMs = 300

type fsWatcher struct {
	mu  sync.Mutex
	fd  int
	wd2dir map[int]string
	dir2wd map[string]int
	enc  *safeEncoder
	stop chan struct{}
	// 合并中的脏目录集合与冲刷定时器（都在 mu 保护下）
	dirty   map[string]struct{}
	flushAt *time.Timer
}

func newFsWatcher(enc *safeEncoder) (*fsWatcher, error) {
	fd, err := syscall.InotifyInit1(syscall.IN_CLOEXEC)
	if err != nil {
		return nil, err
	}
	w := &fsWatcher{
		fd:     fd,
		wd2dir: make(map[int]string),
		dir2wd: make(map[string]int),
		enc:    enc,
		stop:   make(chan struct{}),
		dirty:  make(map[string]struct{}),
	}
	go w.readLoop()
	return w, nil
}

// setDirs：整组替换监听集合（幂等）。与请求循环同线程调用，内部自己加锁。
func (w *fsWatcher) setDirs(dirs []string) {
	want := make(map[string]struct{}, len(dirs))
	for _, d := range dirs {
		want[d] = struct{}{}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	// 摘掉的：集合里没有就 RmWatch（IN_IGNORED 事件随之而来，readLoop 里再清表也行，这里直接清）
	for dir, wd := range w.dir2wd {
		if _, ok := want[dir]; !ok {
			_, _ = syscall.InotifyRmWatch(w.fd, uint32(wd))
			delete(w.dir2wd, dir)
			delete(w.wd2dir, wd)
		}
	}
	// 新增的：加不上的目录（权限/已消失）跳过 —— 监听是加分项不是刚需
	for dir := range want {
		if _, ok := w.dir2wd[dir]; ok {
			continue
		}
		wd, err := syscall.InotifyAddWatch(w.fd, dir, fsWatchMask)
		if err != nil {
			continue
		}
		w.dir2wd[dir] = wd
		w.wd2dir[wd] = dir
	}
}

func (w *fsWatcher) close() {
	select {
	case <-w.stop:
	default:
		close(w.stop)
	}
	// 挂着的合并定时器也停掉：close 后不该再有 flush 往 stdout 写事件
	w.mu.Lock()
	if w.flushAt != nil {
		w.flushAt.Stop()
		w.flushAt = nil
	}
	w.mu.Unlock()
	// 注意：Linux 上 Close 不会唤醒阻塞在 Read 上的 goroutine（fdget 持有引用）。
	// 当前唯一调用点是 stop、进程随即退出，readLoop 由进程回收；
	// 若将来加「watcher 重建」路径，要改 nonblock + poll 自管道唤醒。
	_ = syscall.Close(w.fd)
}

// inotify_event 的头部布局（wd/mask/cookie/len 各 4 字节）；名字段紧随
type inotifyHeader struct {
	Wd     int32
	Mask   uint32
	Cookie uint32
	Len    uint32
}

func (w *fsWatcher) readLoop() {
	buf := make([]byte, 64*1024)
	for {
		n, err := syscall.Read(w.fd, buf)
		if err != nil {
			// fd 关了（close）或被打断：看一眼停止信号决定退不退
			select {
			case <-w.stop:
				return
			default:
			}
			if err == syscall.EINTR {
				continue
			}
			return
		}
		for off := 0; off+16 <= n; {
			h := *(*inotifyHeader)(unsafe.Pointer(&buf[off]))
			off += 16 + int(h.Len)
			w.handleEvent(int(h.Wd), h.Mask)
		}
	}
}

func (w *fsWatcher) handleEvent(wd int, mask uint32) {
	w.mu.Lock()
	defer w.mu.Unlock()
	// IN_Q_OVERFLOW（wd=-1）：内核队列溢出，期间事件已丢 ——
	// 把所有监听目录全标脏，让面板整组重列（fsnotify/VS Code 同款处理）
	if wd == -1 {
		for dir := range w.dir2wd {
			w.dirty[dir] = struct{}{}
		}
		if w.flushAt == nil {
			w.flushAt = time.AfterFunc(fsWatchFlushMs*time.Millisecond, w.flush)
		}
		return
	}
	dir, ok := w.wd2dir[wd]
	if !ok {
		return
	}
	// 目录自身被删/移走（或 inotify 自动摘表）：从集合里清掉，不再追它
	if mask&(syscall.IN_DELETE_SELF|syscall.IN_MOVE_SELF|syscall.IN_IGNORED) != 0 {
		delete(w.wd2dir, wd)
		delete(w.dir2wd, dir)
	}
	w.dirty[dir] = struct{}{}
	if w.flushAt == nil {
		w.flushAt = time.AfterFunc(fsWatchFlushMs*time.Millisecond, w.flush)
	}
}

func (w *fsWatcher) flush() {
	w.mu.Lock()
	dirs := make([]string, 0, len(w.dirty))
	for d := range w.dirty {
		dirs = append(dirs, d)
	}
	w.dirty = make(map[string]struct{})
	w.flushAt = nil
	w.mu.Unlock()
	if len(dirs) > 0 {
		_ = w.enc.Encode(event{Event: "fs", Data: map[string]interface{}{"dirs": dirs}})
	}
}

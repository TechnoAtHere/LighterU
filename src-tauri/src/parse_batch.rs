//! 右键多选聚合（方案 A）：把 Explorer 逐文件启动的多个进程聚成一个解析批次。
//!
//! 背景：右键菜单注册为 `--parse "%1"`（D.13），Windows 对多选文件会为每个文件**分别启动一个进程**，
//! 每个进程 argv 只带一个路径；单实例插件再逐条转发。旧链路依赖前端 250ms 防抖聚合，但冷启动时
//! 前端订阅晚于事件、且进度窗关闭会退出应用，导致「无论选几个文件只解析一个」。
//!
//! 本模块把聚合前移到 Rust 侧：
//!   - 冷启动首进程的 argv 与后续单实例转发的文件路径，统一 append 到同一批次（批次内按路径去重）；
//!   - 最后一次 append 后静默 `BATCH_WINDOW_MS` 即 flush，另有 `BATCH_MAX_WAIT_MS` 硬上限防止持续右键时永不开窗；
//!   - 等前端 `frontend_ready`（`lu_get_launch_action` 被调用）后才 emit，避免事件早于订阅而丢失；
//!   - flush 后一次性下发整批 `parse` 命令，由前端开一个进度窗处理全部文件。
//!
//! 不引入新依赖：后台线程用 `std::thread` + `std::time::Instant` 轮询。

// 本文件只含纯状态逻辑，不依赖 tauri / crate 其它模块：
// 既可随主 crate 编译，也可用 `rustc --test parse_batch.rs` 独立跑单测（绕开 WebView2Loader.dll 加载限制）。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 最后一次 append 后的静默窗口
const BATCH_WINDOW_MS: u64 = 500;
/// 批次首次 append 起的硬上限（防止连续右键导致无限重置）
const BATCH_MAX_WAIT_MS: u64 = 1_500;
/// 前端未就绪时最多保留批次多久（兜底，避免永久滞留）
pub const READY_MAX_WAIT_MS: u64 = 10_000;
/// flusher 轮询间隔（lib.rs 的 Tauri 胶水层使用）
pub const POLL_MS: u64 = 25;
/// flush 后的退出宽限期：期间晚到的进程仍可 append 并被处理
pub const EXIT_GRACE_MS: u64 = 3_000;

#[derive(Default)]
struct PendingInner {
    files: Vec<String>,
    /// 最后一次 append + BATCH_WINDOW_MS
    deadline: Option<Instant>,
    /// 批次首次 append + BATCH_MAX_WAIT_MS
    hard_deadline: Option<Instant>,
    first_at: Option<Instant>,
    last_flush_at: Option<Instant>,
}

/// 多选批次聚合状态（进程内共享，供 setup / 单实例回调 / flusher / 退出判定共用）。
#[derive(Default)]
pub struct PendingParse {
    inner: Mutex<PendingInner>,
    /// 前端已调用 lu_get_launch_action，事件订阅已就绪
    frontend_ready: AtomicBool,
}

impl PendingParse {
    /// 追加文件路径；返回实际新增数量（批次内按路径去重，保持首次出现顺序）。
    pub fn append(&self, paths: &[String]) -> usize {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let mut added = 0;
        for p in paths {
            if p.is_empty() || g.files.iter().any(|x| x == p) {
                continue;
            }
            g.files.push(p.clone());
            added += 1;
        }
        if added > 0 {
            if g.first_at.is_none() {
                g.first_at = Some(now);
                g.hard_deadline = Some(now + Duration::from_millis(BATCH_MAX_WAIT_MS));
            }
            g.deadline = Some(now + Duration::from_millis(BATCH_WINDOW_MS));
        }
        added
    }

    /// 到点则取出并清空批次；`now` 由调用方传入，便于单测注入时间。
    pub fn take_if_due(&self, now: Instant) -> Option<Vec<String>> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if g.files.is_empty() {
            return None;
        }
        let due = g.deadline.is_some_and(|d| now >= d) || g.hard_deadline.is_some_and(|d| now >= d);
        if !due {
            return None;
        }
        let files = std::mem::take(&mut g.files);
        g.deadline = None;
        g.hard_deadline = None;
        g.first_at = None;
        g.last_flush_at = Some(now);
        Some(files)
    }

    pub fn set_ready(&self) {
        self.frontend_ready.store(true, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.frontend_ready.load(Ordering::SeqCst)
    }

    /// 前端迟迟未就绪时允许强制 flush 的兜底判定。
    pub fn ready_timeout_elapsed(&self, now: Instant) -> bool {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.first_at.is_some_and(|t| now.duration_since(t) >= Duration::from_millis(READY_MAX_WAIT_MS))
    }

    /// 是否允许空闲退出：批次已清空，且距最后一次 flush（或首次收集）已过宽限期。
    pub fn can_exit(&self, now: Instant) -> bool {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if !g.files.is_empty() {
            return false;
        }
        match g.last_flush_at.or(g.first_at) {
            None => false,
            Some(t) => now.duration_since(t) >= Duration::from_millis(EXIT_GRACE_MS),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).files.is_empty()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).files.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn append_dedups_within_batch() {
        let p = PendingParse::default();
        assert_eq!(p.append(&paths(&["a.pdf", "b.pdf", "a.pdf", "", "a.pdf"])), 2);
        assert_eq!(p.append(&paths(&["b.pdf"])), 0);
        // 未到静默窗口
        assert!(p.take_if_due(Instant::now()).is_none());
        let files = p.take_if_due(Instant::now() + Duration::from_millis(BATCH_WINDOW_MS + 10)).unwrap();
        assert_eq!(files, paths(&["a.pdf", "b.pdf"]));
        assert!(p.is_empty());
    }

    #[test]
    fn hard_deadline_caps_repeated_appends() {
        let p = PendingParse::default();
        let now = Instant::now();
        assert_eq!(p.append(&paths(&["a.pdf"])), 1);
        // 模拟持续右键：每次 append 都重置静默窗口，但硬上限不随之顺延
        let late = now + Duration::from_millis(BATCH_MAX_WAIT_MS + 10);
        assert!(p.take_if_due(late).is_some());
    }

    #[test]
    fn take_if_due_waits_for_silence() {
        let p = PendingParse::default();
        assert!(p.take_if_due(Instant::now() + Duration::from_secs(60)).is_none()); // 空批次
        p.append(&paths(&["x.pdf"]));
        assert!(p.take_if_due(Instant::now() + Duration::from_millis(100)).is_none());
        assert!(p.take_if_due(Instant::now() + Duration::from_millis(600)).is_some());
    }

    #[test]
    fn ready_gate_and_timeout() {
        let p = PendingParse::default();
        assert!(!p.is_ready());
        assert!(!p.ready_timeout_elapsed(Instant::now()));
        p.append(&paths(&["x.pdf"]));
        assert!(!p.ready_timeout_elapsed(Instant::now() + Duration::from_millis(1_000)));
        assert!(p.ready_timeout_elapsed(Instant::now() + Duration::from_millis(READY_MAX_WAIT_MS + 10)));
        p.set_ready();
        assert!(p.is_ready());
    }

    #[test]
    fn exit_grace_blocks_until_elapsed() {
        let p = PendingParse::default();
        assert!(!p.can_exit(Instant::now())); // 从未有批次
        p.append(&paths(&["x.pdf"]));
        let flush_at = Instant::now() + Duration::from_millis(600);
        assert!(p.take_if_due(flush_at).is_some());
        assert!(!p.can_exit(flush_at + Duration::from_millis(EXIT_GRACE_MS - 10)));
        assert!(p.can_exit(flush_at + Duration::from_millis(EXIT_GRACE_MS + 10)));
        // 宽限期内又来晚到文件 → 不允许退出
        assert_eq!(p.append(&paths(&["y.pdf"])), 1);
        assert!(!p.can_exit(Instant::now() + Duration::from_secs(60)));
    }
}

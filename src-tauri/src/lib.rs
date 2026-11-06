// LighterU Rust 外壳：插件注册 + 自定义命令。
// 插件（T1-02）：opener / fs / sql / store / dialog / http / single-instance（T4-07）。
// 自定义命令（commands.rs）：任意路径文件 IO（std::fs + 长路径前缀）+ DPAPI 密钥保护。
// cli.rs（T4-07/右键传参）：命令行解析 + 首次启动意图拉取。
// registry.rs（T4-01）：右键菜单 HKCU 每用户注册（P-5）。
// 不做托盘、不做悬浮窗（D-02、D-13）。

mod cli;
mod commands;
mod registry;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// D.12：Rust 链路日志落盘目录（发布版无控制台，写文件便于排查；dev 仍同时打 stderr）
static LOG_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// 由 Unix 秒算 UTC 公历日期 (Y, M, D)（Howard Hinnant civil_from_days，无第三方依赖）
fn ymd_now() -> (i64, u32, u32) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs / 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y_raw = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (y_raw + if m <= 2 { 1 } else { 0 }, m, d)
}

/// D.11/D.12 链路日志（Rust 侧）：统一 JSON 单号；dev 打 stderr（Tauri 控制台），
/// 同时追加到 appConfigDir/logs/lu-rust-YYYY-MM-DD.log（发布版无控制台时唯一可见途径）。
/// 不引入新依赖；仅用于追踪「右键直接解析 → 窗口路由」链路，不改变任何业务逻辑。
fn lu_log(level: &str, module: &str, event: &str, action: Option<&str>, extra: serde_json::Value) {
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut obj = serde_json::json!({
        "ts_ms": ts_ms,
        "level": level,
        "module": module,
        "event": event,
    });
    if let Some(a) = action {
        obj["action"] = serde_json::json!(a);
    }
    if !extra.is_null() {
        obj["data"] = extra;
    }
    eprintln!("[lu-log] {}", obj);
    if let Some(dir) = LOG_DIR.get() {
        // 轮 I：写入前确保目录存在（目录被误删也能自愈，避免静默丢失 Rust 侧日志）
        let _ = std::fs::create_dir_all(dir);
        let (y, m, d) = ymd_now();
        let path = dir.join(format!("lu-rust-{:04}-{:02}-{:02}.log", y, m, d));
        use std::io::Write as _;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{}", obj);
        }
    }
}

/// G：每轮「直接解析」独立窗口的待解析文件暂存（按 window label 隔离，规避多窗竞态）。
/// 进度窗挂载后调用 lu_take_progress_files(label) 一次性取走并清空。
#[derive(Default)]
struct ProgressFiles(Mutex<HashMap<String, Vec<String>>>);

/// G（轮 G·3）：打开一个全新的「直接解析」进度窗，每轮一个独立窗口（label = progress-N）。
/// 文件路径经状态暂存而非事件握手传递，规避多窗竞态；窗口置顶 + 聚焦（覆盖在 LighterU 之上）；
/// 关闭即销毁（不复用），main 隐藏时（首启 --parse 场景）随应用退出。
#[tauri::command]
async fn lu_open_progress(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProgressFiles>,
    file_paths: Vec<String>,
) -> Result<String, String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    static PROGRESS_SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = PROGRESS_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("progress-{seq}");
    state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(label.clone(), file_paths);

    // G·6 / Windows 死锁规避：tauri webview_window.rs 已知「同步 command 内建窗在 Windows 死锁」。
    // 故把建窗放到独立异步线程，避免 WebView2 初始化卡死（表现为白屏 / 无响应 / 进程被杀）。
    let label2 = label.clone();
    let app2 = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let builder = WebviewWindowBuilder::new(&app2, label2.clone(), WebviewUrl::App("index.html".into()))
            .title("直接解析")
            .inner_size(600.0, 420.0)
            .resizable(true)
            .center();
        let win = builder.build().map_err(|e| e.to_string())?;

        // G·6：打开即置顶 + 聚焦（跳到所有窗口最上层）
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();

        // G·3：关闭即销毁（每轮独立窗口，不复用）；main 隐藏时（首启 --parse 唯一可见窗）随应用退出
        let h = app2.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let main_visible = h
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                if !main_visible {
                    h.exit(0);
                }
            }
        });
        Ok::<String, String>(label2)
    });
    match handle.await {
        Ok(Ok(l)) => Ok(l),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("spawn join error: {e}")),
    }
}

/// G（轮 G·3）：进度窗挂载后取走本窗的待解析文件（一次性，取走即清空）。
#[tauri::command]
fn lu_take_progress_files(
    state: tauri::State<'_, ProgressFiles>,
    label: String,
) -> Option<Vec<String>> {
    // 安全：只允许进度窗读取自己的暂存文件
    if !label.starts_with("progress-") {
        return None;
    }
    let mut map = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    map.remove(&label)
}

/// G（轮 G·3）：由进度窗 UI 调用以关闭并销毁本窗（Rust 侧销毁，不依赖 JS 关闭权限）。
/// 用户点击窗口 X 亦触发 CloseRequested，由 lu_open_progress 挂载的 handler 放行销毁。
/// 进度窗「转到工作站」：显示/置前主窗口，并通知前端切回工作站视图。
#[tauri::command]
fn lu_show_workbench(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter as _, Manager as _};
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let _ = app.emit(
        cli::CLI_EVENT,
        cli::CliCommand { action: "open-workbench".into(), file_paths: None },
    );
    Ok(())
}

#[tauri::command]
fn lu_close_progress(app: tauri::AppHandle, label: String) -> Result<(), String> {
    // 安全：只允许关闭进度窗，禁止销毁主窗口等其它窗口
    if !label.starts_with("progress-") {
        return Err("仅允许关闭进度窗".to_string());
    }
    if let Some(w) = app.get_webview_window(&label) {
        w.destroy().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // debug 构建不注册单实例插件（D-81），故 `mut` 在 dev 下未使用；release 需要它。
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init());

    // T4-07 单实例：仅 release 注册。dev 禁用可规避「快速重启时单实例 IPC 锁残留，
    // 新进程把参数转给已死/僵住的旧实例后直接退出、setup 不执行、无窗口」这一整类问题；
    // dev 由用户手动保证不重复启动（tauri CLI 也会阻止重复 dev），release 仍保留单实例。
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Emitter as _;
            use tauri::Manager as _;
            let action = cli::parse_launch_args(&argv);
            // D.8：直接解析（含多文件）不抢占主工作站焦点——由前端开进度窗并聚焦；
            // 仅"打开工作站/设置"类动作才聚焦主窗口。
            let focused_main = !matches!(action, cli::LaunchAction::DirectParse(_));
            if focused_main {
                if let Some(win) = app.get_webview_window("main") {
                    // 轮 I：第二实例启动时确保已有实例窗口可见并置前（此前仅 set_focus，若窗口隐藏/最小化则无效）。
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            lu_log(
                "info",
                "rust",
                "single_instance",
                None,
                serde_json::json!({
                    "action": action.to_command().action,
                    "focused_main": focused_main,
                    "file_count": match &action { cli::LaunchAction::DirectParse(p) => p.len(), _ => 0 },
                    "argv": argv,
                }),
            );
            let _ = app.emit(cli::CLI_EVENT, action.to_command());
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::lu_read_file,
            commands::lu_write_file,
            commands::lu_ensure_dir,
            commands::lu_exists,
            commands::lu_file_size,
            commands::lu_read_dir,
            commands::lu_remove_dir,
            commands::lu_protect_secret,
            commands::lu_unprotect_secret,
            cli::lu_get_launch_action,
            registry::lu_register_context_menu,
            registry::lu_unregister_context_menu,
            registry::lu_is_context_menu_registered,
            registry::lu_set_context_menu,
            lu_open_progress,
            lu_take_progress_files,
            lu_show_workbench,
            lu_close_progress,
        ])
        .setup(|app| {
            use tauri::Manager as _;

            // G：注册「直接解析」每轮独立窗口的待解析文件暂存状态
            app.manage(ProgressFiles::default());

            // D.12：设置 Rust 日志落盘目录（发布版无控制台；dev 亦同时打 stderr）。
            // 置于 launch.parse 日志之前，确保首启路由日志能落文件。
            // 安全：日志写入独立的应用日志目录（$APPLOG），与配置目录（含 DB / 密钥）分离
            if let Ok(dir) = app.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = LOG_DIR.set(dir);
            }

            // 改名说明（合规）：项目曾用名 BetterMinerU，出于合规风险及名称/描述可能被误解的考虑，已更名为 LighterU（LU）。
            lu_log(
                "info",
                "rust",
                "rename.notice",
                None,
                serde_json::json!({
                    "former_name": "BetterMinerU",
                    "current_name": "LighterU",
                    "abbr": "LU",
                    "reason": "合规风险及名称/描述可能被误解，已更名",
                }),
            );

            // 轮 J：setup 进入时间戳。与「进程启动时间」「前端首条日志」三点对照，
            // 可判定启动慢卡在「原生建窗」还是「webview 加载前端」，避免再靠猜。
            lu_log(
                "info",
                "rust",
                "setup.start",
                None,
                serde_json::json!({ "pid": std::process::id() }),
            );

            // T4-07/D.6：主窗口关闭即退出应用（V0.3 无托盘，避免多窗口下关主窗口后进程残留、无法找回）
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        handle.exit(0);
                    }
                });
            }

            // dev-only 诊断：Rust 侧启动标记（与前端 lu-diag.log 的 boot 行对照，
            // 用于区分「Rust 未起」与「前端未加载」）。debug 构建才写。
            #[cfg(debug_assertions)]
            {
                if let Ok(dir) = app.path().app_config_dir() {
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(dir.join("lu-rust-boot.txt"), "rust boot ok\n");
                }
            }

            // T4-01/D.7：每次启动都用当前 exe 幂等重写右键菜单（去掉"仅首次"守卫）。
            // 原因：旧逻辑只在未注册时写一次，command 里的 exe 路径会冻结在首次注册时的构建
            // （历史某次为 debug，console 子系统），导致点菜单启动旧 exe 弹终端。create_subkey +
            // set_value 为覆盖写，幂等；失败仅记日志，不阻断启动。
            if let Ok(exe) = std::env::current_exe() {
                let exe_str = exe.to_string_lossy().to_string();
                // 用户在设置页手动关闭后（标记文件存在）不再自动注册，避免重启后「复活」。
                let menu_disabled = app
                    .path()
                    .app_config_dir()
                    .map(|d| registry::is_context_menu_disabled(&d))
                    .unwrap_or(false);
                if menu_disabled {
                    let _ = registry::unregister_context_menu();
                    lu_log("info", "rust", "registry.register", None, serde_json::json!({ "ok": true, "skipped": "user-disabled" }));
                } else {
                    match registry::register_context_menu(&exe_str) {
                        Ok(()) => {
                            eprintln!("[lu] 右键菜单已刷新为 {}", exe_str);
                            lu_log("info", "rust", "registry.register", None, serde_json::json!({ "ok": true, "exe": exe_str }));
                        }
                        Err(e) => {
                            eprintln!("[lu] 右键菜单自注册失败：{e}");
                            lu_log("error", "rust", "registry.register", None, serde_json::json!({ "ok": false, "error": e }));
                        }
                    }
                }
                // D.12：读回实际写入的命令值（诊断 Explorer 到底会读到什么）
                let (verb, msm) = registry::read_verb_meta();
                lu_log(
                    "info",
                    "rust",
                    "registry.command",
                    None,
                    serde_json::json!({
                        "command": registry::read_command(),
                        "verb": verb,
                        "multi_select_model": msm,
                    }),
                );
            }

            // T4-07：解析本次启动参数存入 LaunchState，前端 onMounted 经 lu_get_launch_action 拉取
            // （避免事件早于前端监听注册的竞态；第二实例走 single-instance 回调的事件推送）
            let argv: Vec<String> = std::env::args().collect();
            let action = cli::parse_launch_args(&argv);
            // D.9：main 窗默认隐藏（tauri.conf visible:false）。非"直接解析"启动才显示主工作站；
            // --parse 首启由前端开进度窗，main 保持隐藏作容器（App.vue 仍挂载并处理启动意图）。
            let main_shown = !matches!(action, cli::LaunchAction::DirectParse(_));
            if main_shown {
                if let Some(main) = app.get_webview_window("main") {
                    // 轮 I：setup 阶段 show() 可能因 webview 未就绪而失败；补 unminimize + focus 保证可见置前。
                    // 前端 App.vue 在拿到 launchAction 后还有一次兜底 show（防止此处静默失败导致无窗口）。
                    let show_res = main.show();
                    let _ = main.unminimize();
                    let _ = main.set_focus();
                    lu_log(
                        "info",
                        "rust",
                        "main.show",
                        None,
                        serde_json::json!({
                            "ok": show_res.is_ok(),
                            "error": show_res.as_ref().err().map(|e| e.to_string()),
                            "visible": main.is_visible().ok(),
                        }),
                    );
                }
            }
            lu_log(
                "info",
                "rust",
                "launch.parse",
                None,
                serde_json::json!({
                    "action": action.to_command().action,
                    "is_direct_parse": matches!(action, cli::LaunchAction::DirectParse(_)),
                    "main_shown": main_shown,
                    "argv_len": argv.len(),
                    "argv": argv,
                }),
            );
            app.manage(cli::LaunchState(std::sync::Mutex::new(Some(action.to_command()))));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

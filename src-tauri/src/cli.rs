//! 命令行参数解析 + 跨窗口命令（T4-07 单实例 / 右键菜单传参）。
//!
//! 右键菜单命令与 CLI 均以参数形式传入：
//!   --parse "<path>" ["<path>" ...]  直接解析（进度窗，输出到源目录；D.8 支持多选多文件）
//!   --open-workbench                 打开主工作站
//!   --open-settings                  打开设置页（T5-07 实现，前期占位）
//!   无参数                           默认打开主工作站
//!
//! 传递路径：
//!   - 首次启动：setup 解析 argv 存入 LaunchState，前端 onMounted 经 `lu_get_launch_action` 拉取（避免事件早于监听注册的竞态）。
//!   - 第二实例：single-instance 回调经 `lu:cli-command` 事件推送（前端已运行，直接监听）。
//! 两路在前端汇聚到同一 handler。
//!
//! D.8 变更：`--parse` 支持一次传入多个文件路径（右键多选 + MultiSelectModel=Player + `%*`）；
//! `--parse-to` / `ParseTo` 已随小窗退役移除。

use serde::Serialize;
use std::sync::Mutex;
use crate::lu_log;

/// 前端统一处理的命令（Serialize 供 event / ipc 传递）
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CliCommand {
    /// "parse" | "open-workbench" | "open-settings"
    pub action: String,
    /// parse 支持多文件（右键多选一次传参）；其余动作为 None
    pub file_paths: Option<Vec<String>>,
}

/// 解析后的启动意图
#[derive(Clone, Debug, PartialEq)]
pub enum LaunchAction {
    /// 直接解析（D.8：支持多文件，右键多选一次性传入）
    DirectParse(Vec<String>),
    OpenWorkbench,
    OpenSettings,
}

impl LaunchAction {
    pub fn to_command(&self) -> CliCommand {
        match self {
            LaunchAction::DirectParse(paths) => CliCommand { action: "parse".into(), file_paths: Some(paths.clone()) },
            LaunchAction::OpenWorkbench => CliCommand { action: "open-workbench".into(), file_paths: None },
            LaunchAction::OpenSettings => CliCommand { action: "open-settings".into(), file_paths: None },
        }
    }
}

/// 扫描 argv（含 argv[0]），命中首个已知 flag 即返回；无则默认打开主工作站。
/// `--parse` 收集其后所有非 flag 参数为文件路径（支持多选）。
pub fn parse_launch_args(args: &[String]) -> LaunchAction {
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--parse" => {
                // 收集后续所有非 flag 参数为文件路径（右键多选 Player 模式一次传多个）
                let mut files: Vec<String> = Vec::new();
                let mut j = i + 1;
                while j < args.len() && !args[j].starts_with("--") {
                    files.push(args[j].clone());
                    j += 1;
                }
                if !files.is_empty() {
                    return LaunchAction::DirectParse(files);
                }
                // --parse 后无值：从 j 继续扫描（无其他 flag → 默认）
                i = j;
                continue;
            }
            "--open-workbench" => return LaunchAction::OpenWorkbench,
            "--open-settings" => return LaunchAction::OpenSettings,
            _ => {}
        }
        i += 1;
    }
    LaunchAction::OpenWorkbench
}

/// 第二实例推送事件名（前端 listen）。
/// dev 构建不注册单实例插件（D-81），故该常量在 debug 下未被引用——显式允许，避免误导性 dead_code 警告。
#[allow(dead_code)]
pub const CLI_EVENT: &str = "lu:cli-command";

/// 首次启动意图（前端拉取用）
#[derive(Default)]
pub struct LaunchState(pub Mutex<Option<CliCommand>>);

/// 前端 onMounted 拉取首次启动意图（竞态安全：不等事件）
#[tauri::command]
pub fn lu_get_launch_action(state: tauri::State<'_, LaunchState>) -> Option<CliCommand> {
    let c = state.0.lock().ok().and_then(|g| g.clone());
    lu_log(
        "debug",
        "rust",
        "get_launch_action",
        c.as_ref().map(|x| x.action.as_str()),
        serde_json::json!({}),
    );
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_direct_parse_single() {
        let a = parse_launch_args(&args(&["lighteru.exe", "--parse", "C:\\a b.pdf"]));
        assert_eq!(a, LaunchAction::DirectParse(vec!["C:\\a b.pdf".to_string()]));
        assert_eq!(a.to_command().action, "parse");
        assert_eq!(a.to_command().file_paths.as_deref(), Some(&["C:\\a b.pdf".to_string()][..]));
    }

    #[test]
    fn parse_direct_parse_multi() {
        // D.8：右键多选一次传多个文件
        let a = parse_launch_args(&args(&["app", "--parse", "D:\\a.pdf", "D:\\b.pdf", "D:\\c.pdf"]));
        assert_eq!(
            a,
            LaunchAction::DirectParse(vec!["D:\\a.pdf".to_string(), "D:\\b.pdf".to_string(), "D:\\c.pdf".to_string()])
        );
        assert_eq!(a.to_command().file_paths.map(|v| v.len()), Some(3));
    }

    #[test]
    fn parse_open_workbench_and_settings() {
        assert_eq!(parse_launch_args(&args(&["app", "--open-workbench"])), LaunchAction::OpenWorkbench);
        assert_eq!(parse_launch_args(&args(&["app", "--open-settings"])), LaunchAction::OpenSettings);
    }

    #[test]
    fn parse_none_defaults_workbench() {
        assert_eq!(parse_launch_args(&args(&["app"])), LaunchAction::OpenWorkbench);
        assert_eq!(parse_launch_args(&args(&[])), LaunchAction::OpenWorkbench);
        // 未知 flag 不匹配，继续扫描
        assert_eq!(
            parse_launch_args(&args(&["app", "--verbose", "--open-settings"])),
            LaunchAction::OpenSettings
        );
    }

    #[test]
    fn parse_missing_value_falls_through() {
        // --parse 后无值 → 继续（无其他 flag → 默认）
        assert_eq!(parse_launch_args(&args(&["app", "--parse"])), LaunchAction::OpenWorkbench);
    }

    #[test]
    fn parse_parse_stops_at_next_flag() {
        // --parse 收集到下一个 flag 前停止，命中即返回
        let a = parse_launch_args(&args(&["app", "--parse", "D:\\x.pdf", "--open-settings"]));
        assert_eq!(a, LaunchAction::DirectParse(vec!["D:\\x.pdf".to_string()]));
    }
}

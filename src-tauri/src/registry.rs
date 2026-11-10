//! 右键菜单注册（T4-01 + D.13，P-5：HKCU 每用户，免管理员，Rust 侧写注册表；仅 Windows）。
//!
//! 右键只保留**一项**「直接解析」（原「解析到…」目录菜单随小窗退役移除）。
//! - 文件右键：`HKCU\Software\Classes\*\shell\LighterU` → command `"{exe}" --parse "%1"`。
//! - **不设 MultiSelectModel**：早期试过 `Player` + `%*`，实测本机 `%*` 展开为空（无任何文件参数、
//!   回退成打开工作站），故 D.13 回退为稳定的单文件 `%1`。
//! - 多选文件由 Windows **逐文件启动进程**，每个 argv 仅带一个路径；多个进程/单实例转发的文件路径
//!   在 Rust 侧经 `parse_batch::PendingParse` 聚成一批后统一下发（方案 A），不依赖 Explorer 多选模型。
//! - 首次运行 + 每次启动都幂等刷新（lib.rs setup 无条件调用），保证 command 始终指向当前 release exe。
//! - 注册时顺带清理旧版遗留：`Directory\shell\LighterU`（原「解析到…」目录菜单）与
//!   `*\shell\BetterMinerU` / `Directory\shell\BetterMinerU`（改名前的旧键，避免右键重复「直接解析」）。
//! - 非 Windows 平台提供空实现（D-01：V0.3 仅 Windows 桌面）。

const MENU_TEXT: &str = "直接解析";
const STAR_KEY: &str = r"Software\Classes\*\shell\LighterU";
/// 改名兼容：旧版（BetterMinerU）遗留的文件右键菜单——启动时幂等清理，
/// 否则升级后右键会出现两个「直接解析」（旧项还指向已不存在的 exe，因而无图标）。
const LEGACY_STAR_KEY: &str = r"Software\Classes\*\shell\BetterMinerU";
/// D.8 遗留清理：原「解析到…」目录右键菜单（已随小窗退役，注册时删除）
const LEGACY_DIR_KEY: &str = r"Software\Classes\Directory\shell\LighterU";
/// 改名兼容：旧版（BetterMinerU）遗留的目录菜单
const LEGACY_DIR_OLD_KEY: &str = r"Software\Classes\Directory\shell\BetterMinerU";
/// 用户手动关闭右键菜单后的持久化标记（位于 app_config_dir）：
/// 存在则该选择在重启后仍然生效；不存在 = 默认安装后自动注册。
pub const DISABLE_MARKER: &str = "context-menu.disabled";

#[cfg(windows)]
pub fn register_context_menu(exe_path: &str) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // 文件右键 → 直接解析
    let (key, _) = hkcu.create_subkey(STAR_KEY).map_err(reg_err)?;
    key.set_value("", &MENU_TEXT).map_err(reg_err)?;
    key.set_value("Icon", &exe_path).map_err(reg_err)?;
    // D.13：单文件改用规范的 "%1"（稳定传入被右键的文件）；并清掉旧的 MultiSelectModel=Player。
    // 实测：`--parse %*` + MultiSelectModel=Player 在本机把 %* 展开为空（single_instance argv=[exe,--parse]，
    // 无文件）→ parse_launch_args 收不到文件、回退 open-workbench（表现为开工作站而非直接解析）。
    // 多选场景暂缓（原 %* 方案本就未生效）；恢复单文件直解析为优先。
    let _ = key.delete_value("MultiSelectModel");
    let (cmd, _) = key.create_subkey("command").map_err(reg_err)?;
    cmd.set_value("", &format!("\"{}\" --parse \"%1\"", exe_path)).map_err(reg_err)?;

    // D.8 / 改名兼容：清理旧版遗留菜单（幂等，不存在也不报错）
    // - Directory\shell\LighterU：原「解析到…」目录菜单（已随小窗退役）
    // - *\shell\BetterMinerU / Directory\shell\BetterMinerU：改名前的旧键，避免右键出现重复项
    let _ = hkcu.delete_subkey_all(LEGACY_DIR_KEY);
    let _ = hkcu.delete_subkey_all(LEGACY_STAR_KEY);
    let _ = hkcu.delete_subkey_all(LEGACY_DIR_OLD_KEY);

    Ok(())
}

#[cfg(windows)]
pub fn unregister_context_menu() -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // 幂等：不存在也不报错；同时清理文件菜单与全部旧版遗留（含改名前的 BetterMinerU 键）
    let _ = hkcu.delete_subkey_all(STAR_KEY);
    let _ = hkcu.delete_subkey_all(LEGACY_DIR_KEY);
    let _ = hkcu.delete_subkey_all(LEGACY_STAR_KEY);
    let _ = hkcu.delete_subkey_all(LEGACY_DIR_OLD_KEY);
    Ok(())
}

#[cfg(windows)]
pub fn is_context_menu_registered() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(STAR_KEY).is_ok()
}

/// D.12 诊断用：读回当前注册的 command 值（确认自注册是否真正落到位、Explorer 实际会读到的命令）
#[cfg(windows)]
pub fn read_command() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(r"Software\Classes\*\shell\LighterU\command")
        .ok()?;
    key.get_value("").ok()
}

/// 诊断用：读回 verb 显示名与 MultiSelectModel（确认菜单项本身）
#[cfg(windows)]
pub fn read_verb_meta() -> (Option<String>, Option<String>) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey(STAR_KEY) {
        Ok(k) => k,
        Err(_) => return (None, None),
    };
    (key.get_value("").ok(), key.get_value("MultiSelectModel").ok())
}

#[cfg(windows)]
fn reg_err(e: std::io::Error) -> String {
    format!("注册表写入失败：{}", e)
}

// ---- 非 Windows 空实现（保持 command 签名跨平台可编译）----
#[cfg(not(windows))]
pub fn register_context_menu(_exe_path: &str) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub fn unregister_context_menu() -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub fn is_context_menu_registered() -> bool {
    false
}
#[cfg(not(windows))]
pub fn read_command() -> Option<String> {
    None
}
#[cfg(not(windows))]
pub fn read_verb_meta() -> (Option<String>, Option<String>) {
    (None, None)
}

#[tauri::command]
pub fn lu_register_context_menu(exe_path: String) -> Result<(), String> {
    // 安全：只允许注册「当前正在运行的程序」，防止渲染层被攻破后被指向任意可执行文件。
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let current_s = current.to_string_lossy().replace('/', "\\");
    let given = exe_path.replace('/', "\\");
    if !given.eq_ignore_ascii_case(&current_s) {
        return Err("拒绝注册非当前程序的右键菜单".to_string());
    }
    register_context_menu(&exe_path)
}

#[tauri::command]
pub fn lu_unregister_context_menu() -> Result<(), String> {
    unregister_context_menu()
}

#[tauri::command]
pub fn lu_is_context_menu_registered() -> bool {
    is_context_menu_registered()
}

/// 启动时据此判断用户是否已手动关闭右键菜单（默认 false = 自动注册）。
pub fn is_context_menu_disabled(config_dir: &std::path::Path) -> bool {
    config_dir.join(DISABLE_MARKER).exists()
}

/// 设置页手动开关：注册/注销 HKCU 右键菜单，并写入/清除持久化标记。
/// 返回操作后的实际注册状态（供 UI 回显）。
#[tauri::command]
pub fn lu_set_context_menu(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri::Manager as _;
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let marker = dir.join(DISABLE_MARKER);
        if enabled {
            let _ = std::fs::remove_file(marker);
        } else {
            let _ = std::fs::write(marker, b"1");
        }
    }
    if enabled {
        let current = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = current.to_string_lossy().to_string();
        register_context_menu(&exe)?;
    } else {
        unregister_context_menu()?;
    }
    Ok(is_context_menu_registered())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn register_unregister_query_idempotent() {
        let exe = std::env::current_exe().unwrap_or_default();
        let exe = exe.to_string_lossy().to_string();
        // 清理到已知态
        let _ = unregister_context_menu();
        assert!(!is_context_menu_registered());
        // 注册 + 重复注册（幂等，不报错）
        assert!(register_context_menu(&exe).is_ok());
        assert!(register_context_menu(&exe).is_ok());
        assert!(is_context_menu_registered());
        // 注销 + 重复注销（幂等）
        assert!(unregister_context_menu().is_ok());
        assert!(unregister_context_menu().is_ok());
        assert!(!is_context_menu_registered());
    }
}

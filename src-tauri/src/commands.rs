//! LighterU Rust 侧自定义命令。
//!
//! - 文件 IO：Tauri fs 插件的 scope 默认只覆盖应用目录；解析输入/输出在任意用户目录，
//!   故用 std::fs 自定义命令（带 Win32 长路径前缀，OT-X to_long_path 语义）。
//! - 密钥保护：Windows DPAPI（CryptProtectData，当前用户作用域）加密，
//!   密文（base64）由前端存入 Tauri store——落盘即密文（D-19 / F-17）。
//!   非 Windows 平台返回明确错误（D-01：V0.3 仅 Windows）。

use std::fs;
use std::path::PathBuf;

use base64::Engine as _;
use tauri::ipc::Response;

/// Win32 长路径前缀：驱动器路径 → `\\?\C:\...`；UNC → `\\?\UNC\server\share\...`。
/// 已带前缀或空前缀时原样返回（OT-X paths.py:88-110 语义）。
///
/// 2026-10-22 修复（真联调暴露）：`\\?\` verbatim 前缀下 Win32 **不做路径规范化**，
/// 正斜杠不会被转成反斜杠——`\\?\E:/大学/...` 是无效 verbatim 路径，
/// CreateDirectory/CreateFile 直接报 ERROR_FILE_NOT_FOUND（os error 2）。
/// 根因链：`output/write.ts` 以 POSIX 分隔符构造输出目录 → 本函数直拼前缀 →
/// 落盘失败。故加前缀前必须先把 `/` 归一为 `\`（UNC 判定同样先用归一化后的串）。
fn long_path(path: &str) -> PathBuf {
    #[cfg(windows)]
    {
        if path.is_empty() {
            return PathBuf::from(path);
        }
        let normalized = path.replace('/', "\\");
        if normalized.starts_with("\\\\?\\") {
            return PathBuf::from(normalized);
        }
        if normalized.starts_with("\\\\") {
            return PathBuf::from(format!("\\\\?\\UNC\\{}", &normalized[2..]));
        }
        PathBuf::from(format!("\\\\?\\{}", normalized))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(path)
    }
}

/// 敏感路径防护（防御纵深）：拒绝系统目录、开机启动项与常见凭据目录，
/// 以及应用密钥文件。正常用户文档/输出目录不受影响。
/// 注意：必须在拼接 `\\?\` 前缀前用原始路径判断（前缀会让前缀匹配失效）。
fn sensitive_path_reason(raw: &str) -> Option<&'static str> {
    #[cfg(windows)]
    {
        let p = raw.to_lowercase().replace('/', "\\");
        let env = |k: &str| std::env::var(k).unwrap_or_default().to_lowercase();
        let win = {
            let v = env("WINDIR");
            if v.is_empty() { "c:\\windows".to_string() } else { v }
        };
        let pf = env("ProgramFiles");
        let pf86 = env("ProgramFiles(x86)");
        let appdata = env("APPDATA");
        let startup = if appdata.is_empty() {
            String::new()
        } else {
            format!("{}\\microsoft\\windows\\start menu\\programs\\startup", appdata)
        };
        let under = |base: &str| {
            !base.is_empty() && (p == base || p.starts_with(&format!("{}\\", base)))
        };
        if under(&win) {
            return Some("Windows 系统目录");
        }
        if under(&pf) || under(&pf86) {
            return Some("Program Files 目录");
        }
        if under(&startup) {
            return Some("开机启动项目录");
        }
        if p.contains("\\.ssh\\") || p.ends_with("\\.ssh") {
            return Some("SSH 凭据目录");
        }
        if p.contains("\\.aws\\") || p.ends_with("\\.aws") {
            return Some("AWS 凭据目录");
        }
        if p.contains("\\.gnupg\\") {
            return Some("GnuPG 凭据目录");
        }
        if p.contains("\\google\\chrome\\user data\\")
            || p.contains("\\microsoft\\edge\\user data\\")
            || p.contains("\\mozilla\\firefox\\profiles\\")
            || p.contains("\\microsoft\\credentials\\")
            || p.contains("\\microsoft\\protect\\")
        {
            return Some("浏览器/系统凭据目录");
        }
        if p.ends_with("\\lu-secrets.json") {
            return Some("应用密钥文件");
        }
        None
    }
    #[cfg(not(windows))]
    {
        let _ = raw;
        None
    }
}

/// 读取任意路径文件为字节流（IPC Response → 前端 Uint8Array）。
#[tauri::command]
pub fn lu_read_file(path: String) -> Result<Response, String> {
    if let Some(reason) = sensitive_path_reason(&path) {
        return Err(format!("拒绝读取受保护路径（{}）：{}", reason, path));
    }
    let bytes = fs::read(long_path(&path)).map_err(|e| format!("读取文件失败 {}: {}", path, e))?;
    Ok(Response::new(bytes))
}

/// 写字节流到任意路径（自动创建父目录）。
#[tauri::command]
pub fn lu_write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(reason) = sensitive_path_reason(&path) {
        return Err(format!("拒绝写入受保护路径（{}）：{}", reason, path));
    }
    let target = long_path(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {:?}: {}", parent, e))?;
    }
    fs::write(&target, &data).map_err(|e| format!("写入文件失败 {}: {}", path, e))
}

/// 确保目录存在。
#[tauri::command]
pub fn lu_ensure_dir(path: String) -> Result<(), String> {
    if let Some(reason) = sensitive_path_reason(&path) {
        return Err(format!("拒绝在受保护路径创建目录（{}）：{}", reason, path));
    }
    fs::create_dir_all(long_path(&path)).map_err(|e| format!("创建目录失败 {}: {}", path, e))
}

/// 路径是否存在。
#[tauri::command]
pub fn lu_exists(path: String) -> Result<bool, String> {
    Ok(long_path(&path).exists())
}

/// 文件大小（字节）。用于读取前做上限校验，避免把超大文件整体读入内存导致 OOM。
#[tauri::command]
pub fn lu_file_size(path: String) -> Result<u64, String> {
    if let Some(reason) = sensitive_path_reason(&path) {
        return Err(format!("拒绝读取受保护路径（{}）：{}", reason, path));
    }
    fs::metadata(long_path(&path))
        .map(|m| m.len())
        .map_err(|e| format!("读取文件信息失败 {}: {}", path, e))
}

/// 列出目录条目（名称 + 是否目录；T2-07 递归扫图用；不递归，深度由调用方控制）。
/// 返回 `Vec<(名称, 是否目录)>`（元组经 IPC 序列化为 `[[name, isDir], ...]`，无需 serde derive）。
#[tauri::command]
pub fn lu_read_dir(path: String) -> Result<Vec<(String, bool)>, String> {
    let target = long_path(&path);
    let mut out: Vec<(String, bool)> = Vec::new();
    let entries = fs::read_dir(target).map_err(|e| format!("读取目录失败 {}: {}", path, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录条目失败 {}: {}", path, e))?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push((entry.file_name().to_string_lossy().to_string(), is_dir));
    }
    Ok(out)
}

/// 递归删除目录（D-99：仅用于清理 DOCX 已内嵌、无需再保留的 images/ 中间产物）。
/// 安全护栏：拒绝受保护路径、拒绝相对路径与盘符根/单层目录，避免误删整盘或用户主目录。
#[tauri::command]
pub fn lu_remove_dir(path: String) -> Result<(), String> {
    if let Some(reason) = sensitive_path_reason(&path) {
        return Err(format!("拒绝删除受保护路径（{}）：{}", reason, path));
    }
    let target = long_path(&path);
    if !target.is_absolute() {
        return Err(format!("拒绝删除相对路径：{}", path));
    }
    // 组件数 < 3 视为盘符根 / 单层目录（如 C:\ 或 C:\Users）
    if target.components().count() < 3 {
        return Err(format!("拒绝删除顶层目录：{}", path));
    }
    if !target.exists() {
        return Ok(());
    }
    if !target.is_dir() {
        return Err(format!("目标不是目录：{}", path));
    }
    fs::remove_dir_all(&target).map_err(|e| format!("删除目录失败 {}: {}", path, e))
}

/// DPAPI 加密明文密钥 → base64 blob（前端存入 Tauri store）。
#[tauri::command]
pub fn lu_protect_secret(plaintext: String) -> Result<String, String> {
    let blob = dpapi_protect(plaintext.as_bytes())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(blob))
}

/// DPAPI 解密 base64 blob → 明文密钥。
#[tauri::command]
pub fn lu_unprotect_secret(blob: String) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(blob.as_bytes())
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    let plain = dpapi_unprotect(&raw)?;
    String::from_utf8(plain).map_err(|e| format!("解密结果不是有效 UTF-8: {}", e))
}

// ---------------------------------------------------------------- DPAPI（Windows）

#[cfg(windows)]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use winapi::ctypes::c_void;
    use winapi::shared::minwindef::TRUE;
    use winapi::um::dpapi::CryptProtectData;
    use winapi::um::winbase::LocalFree;
    use winapi::um::wincrypt::DATA_BLOB;

    unsafe {
        let mut input = DATA_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output: DATA_BLOB = std::mem::zeroed();
        // dwflags = 1（CRYPTPROTECT_UI_FORBIDDEN）：无熵、当前用户作用域，禁止任何 UI 提示。
        if CryptProtectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            &mut output,
        ) != TRUE
        {
            return Err(format!("DPAPI 加密失败: {}", std::io::Error::last_os_error()));
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut c_void);
        Ok(out)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use winapi::ctypes::c_void;
    use winapi::shared::minwindef::TRUE;
    use winapi::um::dpapi::CryptUnprotectData;
    use winapi::um::winbase::LocalFree;
    use winapi::um::wincrypt::DATA_BLOB;

    unsafe {
        let mut input = DATA_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output: DATA_BLOB = std::mem::zeroed();
        if CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            &mut output,
        ) != TRUE
        {
            return Err(format!("DPAPI 解密失败: {}", std::io::Error::last_os_error()));
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut c_void);
        Ok(out)
    }
}

#[cfg(not(windows))]
fn dpapi_protect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI 仅支持 Windows（D-01：V0.3 仅 Windows）。".to_string())
}

#[cfg(not(windows))]
fn dpapi_unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI 仅支持 Windows（D-01：V0.3 仅 Windows）。".to_string())
}

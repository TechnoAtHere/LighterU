fn main() {
    // D-98：图标变更必须触发本脚本重跑，否则缓存会继续嵌入旧图标
    // （曾出现 icons 已更新、exe 内仍是空白旧图标的排查结论）。
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}

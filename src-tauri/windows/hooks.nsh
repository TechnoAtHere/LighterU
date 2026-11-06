; D-46 / T5-07：NSIS 卸载钩子 —— 卸载时自动注销 HKCU 右键菜单（与 Rust 端自注册对称）。
; Tauri v2：经 tauri.conf.json bundle.windows.nsis.installerHooks 引入；
; 语法以 Tauri v2 文档为准（NSIS_HOOK_PREUNINSTALL 在卸载流程早期执行）。
; 清理本应用注册的键：文件菜单（*\shell\LighterU）、旧版目录菜单遗留（Directory\shell\LighterU），
; 以及改名前的 BetterMinerU 旧键（一并删除，避免卸载后残留重复的「直接解析」项）。
!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\LighterU"
  DeleteRegKey HKCU "Software\Classes\*\shell\BetterMinerU"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\LighterU"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\BetterMinerU"
!macroend

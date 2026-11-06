# Contributing

## 开发环境

- Windows 10/11（需要 WebView2）
- Node.js 20+
- Rust stable（`x86_64-pc-windows-gnu`）+ MinGW-w64（含 `as.exe`）
- Tauri CLI（`npm run tauri`）

构建细节见 README「从源码构建」。

## 提交前自检

```bash
npm run typecheck
npm run selftest
cd src-tauri && cargo check
```

## 约定

- 只提交源码与必要资源；不要提交 `node_modules/`、`dist/`、`src-tauri/target/`、日志、`lu-config.json`、`lu-secrets.json`。
- 不要在代码、测试或截图中写入真实 Token / API Key。
- 前端使用 Vue 3 `<script setup>` + TypeScript；Rust 提交前建议运行 `cargo fmt`。
- PR 请说明动机、变更点与验证方式；涉及 UI 的附脱敏截图。

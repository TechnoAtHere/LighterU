<p align="center">
  <img src="src/assets/logo.svg" width="96" alt="LighterU logo" />
</p>

<h1 align="center">LighterU</h1>

<p align="center"><strong>更轻、更快、链条更短地将文件转换为 AI 可读形式的 Windows 桌面端 MinerU 解析客户端</strong></p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D6" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

<p align="center">
  <a href="https://github.com/TechnoAtHere/LighterU">GitHub</a> ·
  <a href="https://gitee.com/ATWWW/LighterU">Gitee</a>
</p>

---

## 功能介绍

### 右键解析（最短链路）

在资源管理器中对文件点右键 → **直接解析**，只弹出轻量进度窗，解析完成后按设置落盘。进度窗内可一键 **转到工作站**；即使主程序未运行，右键也会拉起后台进程完成解析。

### 工作站解析（批量与可管理）

导入文件或整个文件夹 → **全部开始**。支持队列并发、失败重试、历史任务、实时日志与通知；任务行可单独重跑、修改输出目录、打开结果文件夹。

- 输出格式多选：**Markdown / JSON / DOCX / HTML / 图片**。
- DOCX 自带图片；未勾选「图片」时，图片描述读完会自动删除单独的 `images/`（Markdown「两者都有」模式除外）。

### 图片解析（把图也变成可读文本）

解析完成后，对单个文件点行内 **「图」** 按钮即可用当前提示词方案重跑图片描述：

- 点击即变**蓝色**（已排队）；若文件尚未解析完，会在解析完成后自动执行；
- 完成后变**绿色**（失败保持蓝色，可再次点击重试）；
- 需要先配置一个 OpenAI 兼容的多模态服务（Base URL / 模型 / API Key）。

## 使用说明

### 安装与首次配置

1. 前往 **Releases** 页面下载 `LighterU_<version>_x64-setup.exe` 并安装（Windows 10/11，需 WebView2）。
2. 首次启动后二选一：
   - **精准解析**：在「设置 → MinerU」填入 [mineru.net](https://mineru.net) 的 Token（有效期 90 天）；
   - **Agent 轻量解析**：无需 Token，按 IP 限频，单文件 ≤10MB / ≤20 页，仅输出 Markdown。
3. 如需图片解析，在「设置 → 多模态」填入 OpenAI 兼容服务的 Base URL、模型名与 API Key。

### 常见问题

#### 软件本身

| 现象 | 快速解决 |
|---|---|
| 双击 exe 白屏或无窗口 | 请使用安装包，或 `target/release/lighteru.exe`（发布版已内嵌前端）；开发期请用 `npm run tauri dev`，勿直接双击 `target/debug` 下的裸 exe。确认已安装 WebView2 |
| 右键没有「直接解析」 | 先启动一次应用完成菜单注册；再到「设置 → 输出 → 右键入口」确认「启用右键菜单」已勾选 |
| 图片解析按钮一直蓝色 | 检查「设置 → 多模态」是否已配置；确认该文件已解析完成；查看日志面板 |
| 找不到输出文件 | 任务行点「打开」直接打开输出目录；默认在源文件同目录或设置中的目录 |
| 杀软报 `build-script-build` 木马 | Tauri 构建脚本的无签名启发式误报；将 `src-tauri/target/` 加入信任区后重试 |
| Token 保存失败 | 仅 Windows 支持 DPAPI 加密；确认在 Windows 桌面环境运行 |

#### MinerU 服务

| 现象 | 快速解决 |
|---|---|
| Token 无效 / 过期（A0202） | 到 mineru.net 重新申请 Token 并保存；Token 有效期 90 天 |
| 403 Forbidden | 检查 Token 是否已保存、是否混入空格/换行；检查 API 地址 |
| 429 / 排队 / 限流 | 稍后重试；Agent 模式按 IP 限频，精准模式有每日/每分钟配额 |
| 文件超限 | 精准：≤200MB、≤200 页；Agent：≤10MB、≤20 页。超限请拆分或压缩 |
| 解析结果乱序或缺内容 | 复杂版面/竖排/公式受模型能力限制；可切换模型版本（如 `vlm`）重试 |

### 已知限制

#### 软件本身

- 仅支持 **Windows 10/11**，暂无 macOS / Linux 构建。
- 右键菜单需**先启动一次应用**完成注册；卸载时自动移除。
- 图片解析依赖外部 OpenAI 兼容服务，需自备 Key，费用由该服务计费。
- 单机本地应用，无云同步或多端同步。

#### MinerU 服务

- 配额、频率、文件大小/页数限制以官方说明为准，可能调整。
- Token 有效期 **90 天**，到期需重新申请。
- 解析质量因文档而异，不保证 100% 版式还原。
- Agent 轻量模式仅输出 Markdown、单文件，限制更严格。

## 数据与隐私

- **本地优先**：配置、历史与日志均保存在本机，无自建服务器、无遥测统计。
- **文件去向**：解析请求发送至 `mineru.net`；图片描述发送至你自行配置的多模态服务。
- **密钥安全**：Token 与 API Key 经 Windows DPAPI 加密后存于 `%APPDATA%\com.lighteru.app\lu-secrets.json`，不明文落盘。
- **权限说明**：应用仅申请「打开路径」（`opener:allow-open-path`）用于打开你选择的输出目录与日志目录。该权限范围较宽（允许任意路径），因为输出目录可由用户指定到任意位置；它只调用系统默认程序打开路径，不读取、不上传文件内容。
- **日志脱敏**：本地日志对密钥做掩码，可在设置中清空。
- **卸载**：卸载程序删除右键菜单；本地数据是否保留取决于安装器选项。

## 从源码构建

**环境**

- Windows 10/11 + WebView2
- Node.js 20+
- Rust stable（`x86_64-pc-windows-gnu`）
- MinGW-w64（需含 `as.exe`，并加入 `PATH`）
- NSIS（`tauri build` 首次会自动下载）

**入口**

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 生产
```

**自检**

```bash
npm run typecheck
npm run selftest       # 75/75
cd src-tauri && cargo check
```

**产物**：`src-tauri/target/release/lighteru.exe` 与 `src-tauri/target/release/bundle/nsis/LighterU_<version>_x64-setup.exe`。

> 若安全软件误报 Tauri 构建脚本，请将 `src-tauri/target/` 加入信任区后重试。

## 许可证与致谢

**本项目**采用 [MIT License](LICENSE)。**维护者**：Techno

**关于 MinerU**：本项目是其**非官方**桌面客户端，**不包含** MinerU 源代码，仅通过 mineru.net 的公开 API 调用其服务。MinerU 开源项目自 **v3.1.0** 起采用 **MinerU Open Source License**（基于 Apache-2.0 并附额外条款；此前版本为 AGPLv3）；该许可证要求基于 MinerU 提供在线服务时，在显著位置标注使用了 MinerU——本 README 与 [NOTICE](NOTICE) 已作标注。API 的使用还需遵守 mineru.net 的服务条款、配额与计费规则。

**致谢**

- **MinerU / OpenDataLab**：解析能力与服务对象
- **[Visual-skill](https://github.com/Asonlino/Visuals-Skill)**：产品与交互思路参考
- **[tianshu](https://github.com/magicyuan876/mineru-tianshu)**：工程与链路思路参考
- **Lucide Icons**（ISC）、**Tauri**（MIT / Apache-2.0）、**Vue / Vite** 及所有依赖作者

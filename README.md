<p align="center">
  <img src="src/assets/logo.svg" width="104" alt="LighterU logo" />
</p>

<h1 align="center">LighterU</h1>

<p align="center"><strong>A lighter, faster, shorter-path Windows desktop client that turns files into AI-readable formats — powered by MinerU.</strong></p>

<p align="center">
  <a href="https://github.com/TechnoAtHere/LighterU"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-LighterU-181717?style=flat-square" /></a>
  <a href="https://gitee.com/ATWWW/LighterU"><img alt="Gitee" src="https://img.shields.io/badge/Gitee-LighterU-C71D23?style=flat-square" /></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square" />
  <img alt="Vue" src="https://img.shields.io/badge/Vue-3-42B883?style=flat-square" />
  <img alt="version" src="https://img.shields.io/badge/version-0.3.0-blue?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square" />
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · <a href="README.md">English</a>
</p>

> **Unofficial notice**: LighterU is a third-party desktop client for MinerU (mineru.net / OpenDataLab). It is not affiliated with, or endorsed by, MinerU / OpenDataLab and does not include their source code. Using the API is subject to the official terms and quotas.

---

## 📑 Table of Contents

- [✨ Highlights](#highlights)
- [🧭 Features](#features)
- [📦 Install & Usage](#usage)
- [🔐 Data & Privacy](#privacy)
- [🛠️ Build from Source](#build)
- [📄 License & Credits](#license)

<a id="highlights"></a>
## ✨ Highlights

| Highlights | Details |
|---|---|
| ⚡ **Shortest path** | Right-click a file in Explorer; only a lightweight progress window appears. |
| 🖥️ **Two entry points** | Single-file right-click and batch workbench, with independent settings. |
| 🧩 **Multi-format** | Markdown · JSON · DOCX · HTML · images, selectable. |
| 🖼️ **Images to text** | Works with any OpenAI-compatible multimodal endpoint to generate image descriptions. |
| 🔒 **Local-first** | No self-hosted server, no telemetry; secrets encrypted with Windows DPAPI. |

<a id="features"></a>
## 🧭 Features

### 🖱️ Right-click parsing (shortest path)

Right-click a file in Explorer → **Parse directly**. Only a lightweight progress window appears; results are written according to your settings. You can jump to the workbench from the window. If the app isn't running, the right-click action starts the background process and parses anyway.

### 🖥️ Workbench parsing (batch & manageable)

Import files or a folder → **Start all**. Queue concurrency, retries, history, live logs, and notifications; each row can be re-run, change its output folder, or open the result folder.

- 📦 Output formats: **Markdown / JSON / DOCX / HTML / images**.
- 🖼️ DOCX embeds images; when **Images** is unchecked, the standalone `images/` folder is deleted after captioning (except Markdown "both" mode).

### 🖼️ Image captioning (turn images into text)

After parsing, click the **“图” (Image)** button on a file to re-run captioning with the current prompt preset:

- 🔵 Turns **blue** on click (queued); if the file isn't parsed yet, it runs automatically when parsing completes.
- 🟢 Turns **green** when done (stays blue on failure; click again to retry).
- 🔑 Requires an OpenAI-compatible multimodal endpoint (Base URL / model / API key).

<a id="usage"></a>
## 📦 Install & Usage

### 1️⃣ Install

Download `LighterU_<version>_x64-setup.exe` from **Releases**.

> Windows 10/11 with WebView2 (usually preinstalled on Windows 11).

### 2️⃣ First-run setup

1. **Parsing service** (choose one)
   - **Precise API**: set your [mineru.net](https://mineru.net) Token in Settings → MinerU (valid for 90 days).
   - **Agent API**: no token; IP rate-limited; single file ≤10MB / ≤20 pages; Markdown only.
2. **Image captioning** (optional): set the OpenAI-compatible Base URL, model, and API key in Settings → Image Captioning.
3. **Output preferences**: choose default formats, folder, and image retention in Settings → Output.

### 3️⃣ FAQ

#### 🧩 App

| Symptom | Quick fix |
|---|---|
| Blank window when double-clicking the exe | Use the installer or `target/release/lighteru.exe` (release builds embed the frontend); during development use `npm run tauri dev`, not the bare exe under `target/debug` |
| No “Parse directly” in the context menu | Launch the app once to register the menu; then check Settings → Output → Right-click entry → “Enable context menu” |
| Image button stays blue | Check Settings → Image Captioning; make sure the file has finished parsing; check the log panel |
| Can't find the output | Click “Open” on the task row; output defaults to the source folder or the configured folder |
| Antivirus flags `build-script-build` | False positive for Tauri's unsigned build script; trust `src-tauri/target/` and retry |
| Token save fails | DPAPI is Windows-only; run the app on Windows desktop |

#### ☁️ MinerU

| Symptom | Quick fix |
|---|---|
| Token invalid / expired (A0202) | Re-issue a token on mineru.net and save it; tokens are valid for 90 days |
| 403 Forbidden | Check the token is saved and has no spaces/newlines; verify the API base URL |
| 429 / queuing / rate limit | Retry later; Agent mode is IP rate-limited; the precise API has daily and per-minute quotas |
| File too large | Precise: ≤200MB, ≤200 pages; Agent: ≤10MB, ≤20 pages. Split or compress the file |
| Garbled or missing content | Complex layouts, vertical text, and formulas are limited by the model; try another model version (e.g. `vlm`) |

### 4️⃣ Known limitations

#### 🧩 App

- 🪟 Windows 10/11 only; no macOS/Linux builds yet.
- 🖱️ The context menu requires **one app launch** to register; uninstall removes it.
- 🔌 Captioning depends on an external OpenAI-compatible service; you provide the key and pay that service.
- 💻 Local single-machine app; no cloud or multi-device sync.

#### ☁️ MinerU

- 📊 Quotas, rate limits, and size/page limits follow the official docs and may change.
- ⏳ Tokens expire after **90 days**.
- 🧠 Parsing quality varies by document; 100% layout fidelity is not guaranteed.
- 🪶 Agent mode is Markdown-only and single-file, with stricter limits.

<a id="privacy"></a>
## 🔐 Data & Privacy

- 🏠 **Local-first**: config, history, and logs stay on your machine; no self-hosted server, no telemetry.
- 📤 **Where files go**: parse requests go to `mineru.net`; captions go to the multimodal endpoint you configure.
- 🔑 **Secrets**: tokens and API keys are encrypted with Windows DPAPI and stored in `%APPDATA%\com.lighteru.app\lu-secrets.json`; never stored in plaintext.
- 🛡️ **Permissions**: the app requests `opener:allow-open-path` only to open output/log folders you choose. The scope is broad (any path) because output folders can be anywhere; it only asks the OS to open a path and never reads or uploads file contents.
- 🧾 **Log masking**: local logs mask secrets and can be cleared in Settings.
- 🗑️ **Uninstall**: removes the context menu; whether local data is kept depends on the installer option.

<a id="build"></a>
## 🛠️ Build from Source

**Requirements**

- 🪟 Windows 10/11 + WebView2
- 🟢 Node.js 20+
- 🦀 Rust stable (`x86_64-pc-windows-gnu`)
- ⚙️ MinGW-w64 (with `as.exe` on `PATH`)
- 📦 NSIS (downloaded automatically on the first `tauri build`)

**Commands**

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # production
```

**Checks**

```bash
npm run typecheck
npm run selftest       # 75/75
cd src-tauri && cargo check
```

**Artifacts**

- `src-tauri/target/release/lighteru.exe`
- `src-tauri/target/release/bundle/nsis/LighterU_<version>_x64-setup.exe`

> 💡 If antivirus flags Tauri's build script, trust `src-tauri/target/` and retry.

<a id="license"></a>
## 📄 License & Credits

**License**: [MIT License](LICENSE). **Maintainer**: Techno

**About MinerU**: LighterU is an **unofficial** desktop client. It does **not include** MinerU's source code and only calls the public mineru.net API. Since **v3.1.0**, MinerU uses the **MinerU Open Source License** (Apache-2.0-based with additional terms; AGPLv3 before that). It requires prominent attribution when providing an online service based on MinerU — this README and [NOTICE](NOTICE) do so. API usage is subject to mineru.net's terms, quotas, and billing rules.

**Credits**

- 🙏 **[MinerU / OpenDataLab](https://mineru.net)**: parsing capability and service
- 🎨 **[Visual-skill](https://github.com/Asonlino/Visuals-Skill)**: product and interaction inspiration
- 🧠 **[tianshu](https://github.com/magicyuan876/mineru-tianshu)**: engineering and pipeline inspiration
- 🧩 **Lucide Icons** (ISC), **Tauri** (MIT / Apache-2.0), **Vue / Vite**, and all dependency authors

---

<p align="center">Made with ❤️ by <a href="https://github.com/TechnoAtHere">Techno</a></p>

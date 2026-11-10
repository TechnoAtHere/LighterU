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
  <img alt="version" src="https://img.shields.io/badge/version-0.3.1-blue?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square" />
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · <a href="README.md">English</a>
</p>

> **Unofficial notice**: LighterU is a third-party desktop client for MinerU (mineru.net / OpenDataLab). It is not affiliated with, or endorsed by, MinerU / OpenDataLab and does not include their source code. Using the API is subject to the official terms and quotas.

---

## 📑 Table of Contents

- [✨ Highlights](#highlights)
- [🔧 Features](#features)
- [📦 Install & Usage](#usage)
- [🔐 Data & Privacy](#privacy)
- [🛠️ Build from Source](#build)
- [📄 License & Credits](#license)

<a id="highlights"></a>
## ✨ Highlights

| Highlights | Details |
|---|---|
|  **Shortest path** | Right-click a file in Explorer; only a lightweight progress window appears |
|  **Two entry points** | Single-file right-click and batch workbench, with independent settings |
|  **Multi-format output** | Markdown · JSON · DOCX · HTML · images, freely selectable |
|  **Images to text** | Works with any OpenAI-compatible multimodal service to generate image descriptions |
|  **Local-first** | No self-hosted server, no telemetry; secrets encrypted with Windows DPAPI |

<a id="features"></a>
## 🔧 Features

### Output format selection

Output formats are multi-select: **Markdown / JSON / DOCX / HTML / images**, with custom combinations.

### Right-click parsing (shortest path)

After the first launch of the app, right-click a supported file in Explorer → choose **Parse directly** from the context menu. Only a lightweight progress window appears; results are written according to your settings and the window then closes silently. Even if the app is not running, the right-click action starts the background process and completes the parse.

### Workbench parsing (batch & manageable)

Import files or an entire folder → click **Start all** or switch to **Auto-start mode**. Supports automatic queue concurrency, file splitting and reassembly, failure retries, and task history; each task can be re-run individually or have its output folder changed.

### Image captioning (turn images into text)

After parsing, click the inline **"图" (Image)** button on a file, or enable **Caption images by default** in Settings, to generate descriptions with the current prompt preset:

- Requires an OpenAI-compatible multimodal service to be configured first.

<a id="usage"></a>
## 📦 Install & Usage

### Install

Download `LighterU_<version>_x64-setup.exe` from **Releases** and install it.

> System requirements: Windows 10/11 with WebView2 (usually preinstalled on Windows 11).

### First-run setup

After the first launch, configure as needed:

1. **Parsing service** (choose one)
   - **Precise parsing**: enter your [mineru.net](https://mineru.net) Token in Settings → MinerU (as required by MinerU, tokens are valid for 90 days);
   - **Agent lightweight parsing**: no token required; ≤10MB per upload. PDFs over 20 pages are automatically split into 20-page parts, parsed sequentially, and merged into one Markdown file.
2. **Image captioning** (optional): set the Base URL, model name, and API key of an OpenAI-compatible service in Settings → Image Captioning.
3. **Output preferences**: choose default formats, folder, and image retention policy in Settings → Output.

### FAQ

#### Usage issues

| Symptom | Quick fix |
|---|---|
| No "Parse directly" in the context menu | Launch the app once to register the menu; then check Settings → Output → Right-click entry → "Enable context menu" |
| Image button stays blue | Check Settings → Image Captioning; make sure the file has finished parsing; check the log panel |
| Can't find the output files | Click "Open" on the task row to open the output folder; output defaults to the source folder or the configured folder |
| Token save fails | DPAPI is Windows-only; run the app on Windows desktop |
| I want to remove the context menu | Disable the context menu directly in Settings → Output |

#### MinerU service

| Symptom | Quick fix |
|---|---|
| Token invalid / expired (A0202) | Re-issue a token on mineru.net and save it; tokens are valid for 90 days |
| 403 Forbidden | Check the token is saved and has no spaces/newlines; verify the API base URL |
| 429 / queuing / rate limit | Retry later; Agent mode is IP rate-limited; the precise API has daily and per-minute quotas |
| File too large | Precise: ≤200MB, ≤200 pages; Agent: ≤10MB per upload (long PDFs auto-split into 20-page parts). Compress the file or switch to Precise |
| Garbled or missing content | Complex layouts, vertical text, and formulas are limited by the model; try another model version (e.g. `vlm`) |

- 📃 See the official MinerU documentation: https://mineru.net/apiManage/docs

### Known limitations

#### App

-  Only supports **Windows 10/11**; no macOS / Linux builds yet.
-  The context menu requires **one app launch** to register; uninstall removes it.
-  Captioning depends on an external OpenAI-compatible service; you provide the key and pay that service.
-  Local single-machine app; no cloud or multi-device sync.

#### MinerU service

-  Quotas, rate limits, and size/page limits follow the official docs and may change.
-  Tokens expire after **90 days** and must be re-issued.
-  Parsing quality varies by document; 100% layout fidelity is not guaranteed.
-  Agent mode is Markdown-only (long PDFs are auto-split into parts and merged), with stricter IP rate limits.


### Other

- The author is not a professional software engineer. Please excuse any shortcomings.
- Issues are welcome. Apart from urgent matters, the author will review and address them periodically in batches.

<a id="privacy"></a>
## 🔐 Data & Privacy

-  **Local-first**: config, history, and logs stay on your machine; no self-hosted server, no telemetry.
-  **Where files go**: parse requests go to `mineru.net`; captions go to the multimodal service you configure.
-  **Secrets**: tokens and API keys are encrypted with Windows DPAPI and stored in `%APPDATA%\com.lighteru.app\lu-secrets.json`; never stored in plaintext.
-  **Permissions**: the app requests "open path" (`opener:allow-open-path`) only to open the output and log folders you choose, so you can jump to the corresponding folder in one click. It only asks the OS to open a path and never reads or uploads file contents.
-  **Log masking**: local logs mask secrets and can be cleared in Settings.
-  **Uninstall**: the uninstaller removes the context menu; whether local data is kept depends on the installer option.

<a id="build"></a>
## 🛠️ Build from Source

**Requirements**

-  Windows 10/11 + WebView2
-  Node.js 20+
-  Rust stable (`x86_64-pc-windows-gnu`)
-  MinGW-w64 (with `as.exe` on `PATH`)
-  NSIS (downloaded automatically on the first `tauri build`)

**Commands**

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # production
```

**Checks**

```bash
npm run typecheck
npm run selftest       # 82/82
cd src-tauri && cargo check
```

**Artifacts**

- `src-tauri/target/release/lighteru.exe`
- `src-tauri/target/release/bundle/nsis/LighterU_<version>_x64-setup.exe`


<a id="license"></a>
## 📄 License & Credits

**This project** uses the [MIT License](LICENSE). **Maintainer**: Techno

**About MinerU**: this project is an **unofficial** desktop client, **does not include** MinerU source code, and only calls the public mineru.net API.

- Special note: since **v3.1.0**, the MinerU open-source project uses the **MinerU Open Source License** (based on Apache-2.0 with additional terms); it requires prominent attribution when providing an online service based on MinerU — this README and [NOTICE](NOTICE) both do so. **API usage is subject to mineru.net's terms of service, quotas, and billing rules (currently no charges apply).**

**Credits**

- 🙏 **[MinerU / OpenDataLab](https://mineru.net)**: parsing capability and service
-  **[Visual-skill](https://github.com/Asonlino/Visuals-Skill)**: product and interaction inspiration
-  **[tianshu](https://github.com/magicyuan876/mineru-tianshu)**: engineering and pipeline inspiration
-  **Lucide Icons** (ISC), **Tauri** (MIT / Apache-2.0), **Vue / Vite**, and all dependency authors

---

## 👤 Author

Techno
- <a href="https://github.com/TechnoAtHere">GitHub Profile</a>
- <a href="https://gitee.com/ATWWW">Gitee Profile</a>

<p align="center">❤️ Made by <a href="https://github.com/TechnoAtHere">Techno  </a>❤️ </p>

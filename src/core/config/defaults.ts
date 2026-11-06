// M01 · core/config/defaults — 默认配置（T1-04）
// 默认值依据：
// - base_url 默认 https://mineru.net/api/v4（plan/04 P-2 + D-28：唯一允许出现该默认值的位置，代码其余部分只从配置读）
// - 超时/轮询/重试/zip 限额：OT config.py:183-186, 204-206（OT-C023~026/050~052 实证）
// - 解析选项：OT config.py:187-192（is_ocr/enable_table/enable_formula=true, language=ch, model_version=vlm）
// - 传输层 auto：T1-03 结论（WebView fetch 被 CORS 拦截 → Tauri 用 plugin-http）
// MIT License — 默认值改编自 MinerU-OCR-Tool（src/mineru_ocr_tool/config.py，D-29 确认 MIT）。

import type { AppConfig } from '../types'

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024

export const DEFAULT_MINERU_BASE_URL = 'https://mineru.net/api/v4'
export const DEFAULT_MINERU_AGENT_BASE_URL = 'https://mineru.net/api/v1/agent'

export const DEFAULT_CONFIG: AppConfig = {
  mineru: {
    baseUrl: DEFAULT_MINERU_BASE_URL,
    agentBaseUrl: DEFAULT_MINERU_AGENT_BASE_URL,
    apiMode: 'precise',
    tokenSavedAt: 0,
    token: '',
    requestTimeoutMs: 60_000,
    taskTimeoutMs: 3_600_000,
    pollIntervalMs: 3_000,
    verifySsl: true,
    maxAttempts: 5,
    parse: {
      isOcr: true,
      enableTable: true,
      enableFormula: true,
      language: 'ch',
      modelVersion: 'vlm',
      pageRanges: '',
      extraFormats: [],
      includeJson: false,
    },
  },
  multimodal: {
    // D-20：默认 OpenAI 兼容 + 空端点，由用户在设置页填写；阶段 1 不启用
    baseUrl: '',
    apiKey: '',
    model: '',
    // T2-03：TS-X006（天枢 DEFAULT_CONCURRENCY）实证默认 4
    concurrency: 4,
    // T2-10：以下为 T2-01/T2-05 模块常量提升为配置项（设置页 T5-07 暴露）
    timeoutMs: 120_000,
    maxAttempts: 3,
    maxImages: 0,
    imageUrlForm: 'data-uri',
    // 轮 J：提示词方案要求「不人为压缩」，硬顶放宽到 4000 字（仍防失控）
    maxDescriptionChars: 4000,
    // 轮 J：提示词方案——默认内置「通用图片」，用户自定义方案另存于 customPrompts（id 以 User 前缀）
    activePromptId: 'general',
    customPrompts: [],
  },
  http: {
    // T1-03：auto = Tauri→plugin-http / Node→fetch
    transport: 'auto',
  },
  limits: {
    maxZipEntries: 20_000,
    maxZipTotalBytes: 2 * GiB,
    maxZipFileBytes: 512 * MiB,
  },
  output: {
    entry: 'workbench',
    outputDir: '',
    // D-31（覆盖 D-25，需求终版 §5.2）：完成后默认不自动打开，避免批量时弹一堆窗口；设置可改回 'open-dir'
    onComplete: 'none',
    // T4-06：轻量进度窗完成后默认自动关闭
    autoCloseProgress: true,
    // T5-02/D-62：右键/工作站双入口输出行为（各含 defaultDir/outputs/format/captionMode/autoOpen/captionEnabled）
    // D-98：outputs 为输出内容多选源数据；format 由其派生（仅 Markdown → 'markdown'，其余 → 'all'）
    rightClick: { defaultDir: '', format: 'markdown', outputs: ['markdown'], captionMode: 'replace', autoOpen: false, captionEnabled: false },
    workbench: { defaultDir: '', format: 'all', outputs: ['markdown', 'json', 'images'], captionMode: 'both', autoOpen: false, captionEnabled: false },
    // T5-02/D-62：同名输出目录处理（suffix=追加序号，现状；overwrite=覆盖）
    sameNameHandling: 'suffix',
  },
  tasks: {
    // T3-06：默认 0 = 不自动重试（失败需用户手动触发）；T3-04 默认并发 1；T3-07 默认 24h 判 stale
    maxRetries: 0,
    queueConcurrency: 1,
    staleTimeoutMs: 86_400_000,
    // T4-04/D-38：默认手动开始（导入后文件为等待态）
    autoStart: false,
  },
  // 轮 I 日志增强：调试日志默认开启（越详细越好）；info/warn/error 始终落盘，debug/trace 受开关控制；
  // 容量上限 50MB 滚动清理，避免单文件无限增长。
  logging: {
    debugEnabled: true,
    maxSizeMB: 50,
  },
}

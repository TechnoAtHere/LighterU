// M01 · core/config — 四级配置分层加载、归一化、密钥注入（T1-04）
// 分层：默认值 < 持久化配置（Tauri store / Node JSON 文件）< 环境变量（dev-only）< 密钥（secrets 适配器）。
// 归一化语义参照 OT config.py:279-295（数值下限钳制、字符串 trim、base_url 去尾斜杠）。

import { BmuError } from '../client/errors'
import { log, maskUrl } from '../platform/logger'
import type { AppConfig, CaptionWriteMode, HttpTransportKind, OutputEntryConfig, OutputFormat, OutputKind, ParseOptions, SameNameHandling } from '../types'
import { DEFAULT_CONFIG, DEFAULT_MINERU_AGENT_BASE_URL, DEFAULT_MINERU_BASE_URL } from './defaults'
import { normalizeCustomPrompts, resolveActivePromptPreset } from '../caption/prompts'
import type { ConfigStore } from '../platform/store'
import type { SecretsAdapter } from '../platform/secrets'
import { SECRET_KEYS } from '../platform/secrets'
import { nodeEnv } from '../platform/env'

/**
 * D-93：启动快照环境标识（不含任何密钥）。
 * 背景：原 load.done 只记 hasToken，baseUrl / apiMode / 模型配错时日志无迹可循，
 * 表现为「莫名失败」而无法自证配置状态。
 */
function appVersion(): string {
  // 由 vite.config.ts 的 define 注入；Node（selftest/headless）未定义时降级
  return typeof __LU_VERSION__ !== 'undefined' ? __LU_VERSION__ : 'dev'
}

function osLabel(): string {
  if (typeof navigator === 'undefined') return 'node'
  const ua = navigator.userAgent ?? ''
  if (!ua) return 'node'
  const m = /Windows NT [\d.]+|Mac OS X [\d_.]+|Linux|Android [\d.]+|iPhone OS [\d_]+/.exec(ua)
  if (m) return m[0]
  return ua.includes('Node.js') ? 'node' : 'unknown'
}

/**
 * 清洗 token / apiKey：仅保留可打印 ASCII（0x21–0x7E）。
 * 背景（#2）：从网页复制常夹带零宽空格 / 全角字符 / 换行，导致 fetch/Headers 构造抛
 * “String contains non ISO-8859-1 code point”，被误报为网络错误。此处统一剔除。
 */
export function sanitizeToken(raw: string): string {
  let s = (raw ?? '').replace(/[^\x21-\x7E]/g, '').trim()
  // 常见粘贴污染：整段带 "Bearer " 前缀或首尾引号；若不清掉会变成 "Bearer Bearer xxx" → 403。
  s = s.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '')
  return s
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function clampBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clampStr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** D-98：输出内容多选归一——全部=五项；至少保留 Markdown */
const OUTPUT_KINDS: OutputKind[] = ['markdown', 'json', 'docx', 'html', 'images']

function clampOutputs(value: unknown): OutputKind[] {
  const set = new Set<OutputKind>()
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && (OUTPUT_KINDS as string[]).includes(v)) set.add(v as OutputKind)
    }
  }
  // 「图片」为显式选择：DOCX 自带图片，不再隐含「图片」。
  // 图片描述需要读图时由 pipeline.effectiveKinds 临时落盘 images/，读完由任务层删除。
  const list = OUTPUT_KINDS.filter((k) => set.has(k))
  return list.length > 0 ? list : ['markdown']
}

/** 由多选派生旧字段 format（兼容 pipeline / tasks 既有判断） */
function deriveFormat(outputs: OutputKind[]): OutputFormat {
  return outputs.length === 1 && outputs[0] === 'markdown' ? 'markdown' : 'all'
}

/**
 * 读取入口输出多选：优先新字段 outputs；
 * 旧配置只有 format 时按其迁移（'all' 视为 Markdown + JSON + 图片，与历史行为一致）。
 */
function readOutputs(raw: unknown, legacyFormat: unknown, fallback: OutputKind[]): OutputKind[] {
  if (Array.isArray(raw)) return clampOutputs(raw)
  if (legacyFormat === 'markdown') return ['markdown']
  if (legacyFormat === 'all') return ['markdown', 'json', 'images']
  return [...fallback]
}

/** T5-02：归一化单入口输出配置（缺字段回退默认） */
function normalizeOutputEntry(raw: unknown, base: OutputEntryConfig): OutputEntryConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const outputs = readOutputs(r.outputs, r.format, base.outputs)
  return {
    defaultDir: clampStr(r.defaultDir, base.defaultDir).trim(),
    outputs,
    format: deriveFormat(outputs),
    captionMode: clampCaptionMode(r.captionMode, base.captionMode),
    autoOpen: clampBool(r.autoOpen, base.autoOpen),
    captionEnabled: clampBool(r.captionEnabled, base.captionEnabled),
  }
}

function clampCaptionMode(value: unknown, fallback: CaptionWriteMode): CaptionWriteMode {
  return value === 'replace' || value === 'both' ? value : fallback
}
function clampSameName(value: unknown, fallback: SameNameHandling): SameNameHandling {
  return value === 'suffix' || value === 'overwrite' ? value : fallback
}

function normalizeParse(raw: unknown): ParseOptions {
  const base = DEFAULT_CONFIG.mineru.parse
  if (typeof raw !== 'object' || raw === null) return { ...base }
  const r = raw as Record<string, unknown>
  const extraFormats = Array.isArray(r.extraFormats)
    ? r.extraFormats.filter((v): v is string => typeof v === 'string')
    : base.extraFormats
  return {
    isOcr: clampBool(r.isOcr, base.isOcr),
    enableTable: clampBool(r.enableTable, base.enableTable),
    enableFormula: clampBool(r.enableFormula, base.enableFormula),
    language: clampStr(r.language, base.language).trim() || base.language,
    modelVersion: clampStr(r.modelVersion, base.modelVersion).trim() || base.modelVersion,
    pageRanges: clampStr(r.pageRanges, base.pageRanges).trim(),
    extraFormats,
    includeJson: clampBool(r.includeJson, base.includeJson),
  }
}

/** 归一化任意来源的部分配置为完整 AppConfig（T1-04 验收：加载函数返回归一化 Config） */
export function normalizeConfig(raw: unknown): AppConfig {
  const d = DEFAULT_CONFIG
  if (typeof raw !== 'object' || raw === null) return structuredClone(d)
  const r = raw as Record<string, unknown>
  const mineru = (typeof r.mineru === 'object' && r.mineru !== null ? r.mineru : {}) as Record<string, unknown>
  const multimodal = (typeof r.multimodal === 'object' && r.multimodal !== null ? r.multimodal : {}) as Record<string, unknown>
  const http = (typeof r.http === 'object' && r.http !== null ? r.http : {}) as Record<string, unknown>
  const limits = (typeof r.limits === 'object' && r.limits !== null ? r.limits : {}) as Record<string, unknown>
  const output = (typeof r.output === 'object' && r.output !== null ? r.output : {}) as Record<string, unknown>
  const tasks = (typeof r.tasks === 'object' && r.tasks !== null ? r.tasks : {}) as Record<string, unknown>
  const logging = (typeof r.logging === 'object' && r.logging !== null ? r.logging : {}) as Record<string, unknown>

  const transport = clampStr(http.transport, d.http.transport)
  if (!['auto', 'fetch', 'plugin-http'].includes(transport)) {
    throw new BmuError('business', `未知 HTTP 传输类型：${transport}`, { code: 'CONFIG_INVALID' })
  }

  const entry = clampStr(output.entry, d.output.entry)
  const onComplete = clampStr(output.onComplete, d.output.onComplete)

  // 轮 J：提示词方案归一化——用户方案 id 统一补 `User` 前缀；当前选中 id 失效时回落内置「通用图片」。
  const customPrompts = normalizeCustomPrompts(multimodal.customPrompts)
  const activePromptId = resolveActivePromptPreset({
    activePromptId: clampStr(multimodal.activePromptId, d.multimodal.activePromptId),
    customPrompts,
  }).id

  return {
    mineru: {
      baseUrl: clampStr(mineru.baseUrl, d.mineru.baseUrl).trim().replace(/\/+$/, '') || DEFAULT_MINERU_BASE_URL,
      agentBaseUrl:
        clampStr(mineru.agentBaseUrl, d.mineru.agentBaseUrl).trim().replace(/\/+$/, '') || DEFAULT_MINERU_AGENT_BASE_URL,
      apiMode: mineru.apiMode === 'agent' ? 'agent' : 'precise',
      tokenSavedAt:
        typeof mineru.tokenSavedAt === 'number' && Number.isFinite(mineru.tokenSavedAt)
          ? Math.max(0, Math.trunc(mineru.tokenSavedAt))
          : 0,
      // D-77/D-80：token 归一化阶段清洗为非 ASCII 之外的字符（去空格/零宽/全角/换行），避免 Headers 构造失败与 403。
      token: sanitizeToken(clampStr(mineru.token, '')),
      requestTimeoutMs: clampInt(mineru.requestTimeoutMs, d.mineru.requestTimeoutMs, 1_000, 600_000),
      taskTimeoutMs: clampInt(mineru.taskTimeoutMs, d.mineru.taskTimeoutMs, 10_000, 86_400_000),
      pollIntervalMs: clampInt(mineru.pollIntervalMs, d.mineru.pollIntervalMs, 500, 600_000),
      verifySsl: clampBool(mineru.verifySsl, d.mineru.verifySsl),
      maxAttempts: clampInt(mineru.maxAttempts, d.mineru.maxAttempts, 1, 20),
      parse: normalizeParse(mineru.parse),
    },
    multimodal: {
      baseUrl: clampStr(multimodal.baseUrl, d.multimodal.baseUrl).trim().replace(/\/+$/, ''),
      apiKey: clampStr(multimodal.apiKey, ''),
      model: clampStr(multimodal.model, d.multimodal.model).trim(),
      concurrency: clampInt(multimodal.concurrency, d.multimodal.concurrency, 1, 16),
      timeoutMs: clampInt(multimodal.timeoutMs, d.multimodal.timeoutMs, 5_000, 600_000),
      maxAttempts: clampInt(multimodal.maxAttempts, d.multimodal.maxAttempts, 1, 10),
      maxImages: clampInt(multimodal.maxImages, d.multimodal.maxImages, 0, 100_000),
      imageUrlForm: clampStr(multimodal.imageUrlForm, d.multimodal.imageUrlForm) === 'raw-base64' ? 'raw-base64' : 'data-uri',
      maxDescriptionChars: clampInt(multimodal.maxDescriptionChars, d.multimodal.maxDescriptionChars, 20, 20_000),
      activePromptId,
      customPrompts,
    },
    http: { transport: transport as HttpTransportKind },
    limits: {
      maxZipEntries: clampInt(limits.maxZipEntries, d.limits.maxZipEntries, 1, 1_000_000),
      maxZipTotalBytes: clampInt(limits.maxZipTotalBytes, d.limits.maxZipTotalBytes, 1024, 64 * 1024 * 1024 * 1024),
      maxZipFileBytes: clampInt(limits.maxZipFileBytes, d.limits.maxZipFileBytes, 1024, 16 * 1024 * 1024 * 1024),
    },
    output: {
      entry: entry === 'context-menu' ? 'context-menu' : 'workbench',
      outputDir: clampStr(output.outputDir, d.output.outputDir).trim(),
      onComplete: onComplete === 'open-dir' || onComplete === 'open-file' || onComplete === 'none' ? onComplete : 'none',
      // T4-06：进度窗完成自动关闭（默认 true）
      autoCloseProgress: clampBool(output.autoCloseProgress, d.output.autoCloseProgress),
      // T5-02/D-62：右键/工作站双入口输出行为 + 同名处理
      rightClick: normalizeOutputEntry(output.rightClick, d.output.rightClick),
      workbench: normalizeOutputEntry(output.workbench, d.output.workbench),
      sameNameHandling: clampSameName(output.sameNameHandling, d.output.sameNameHandling),
    },
    tasks: {
      maxRetries: clampInt(tasks.maxRetries, d.tasks.maxRetries, 0, 10),
      queueConcurrency: clampInt(tasks.queueConcurrency, d.tasks.queueConcurrency, 1, 8),
      staleTimeoutMs: clampInt(tasks.staleTimeoutMs, d.tasks.staleTimeoutMs, 60_000, 86_400_000 * 7),
      autoStart: clampBool(tasks.autoStart, d.tasks.autoStart),
    },
    // 轮 G 日志重构：调试日志默认关闭（生产避免大文件）；容量上限 1~1024MB 钳制
    logging: {
      debugEnabled: clampBool(logging.debugEnabled, d.logging.debugEnabled),
      maxSizeMB: clampInt(logging.maxSizeMB, d.logging.maxSizeMB, 1, 1024),
    },
  }
}

/** 环境变量覆盖（dev-only 无头入口/联调用；生产 Tauri 内不读环境变量） */
export function applyEnvOverrides(config: AppConfig): AppConfig {
  const next = structuredClone(config)
  const baseUrl = nodeEnv('LU_MINERU_BASE_URL')
  if (baseUrl && baseUrl.trim()) next.mineru.baseUrl = baseUrl.trim().replace(/\/+$/, '')
  const outputDir = nodeEnv('LU_OUTPUT_DIR')
  if (outputDir && outputDir.trim()) next.output.outputDir = outputDir.trim()
  const transport = nodeEnv('LU_HTTP_TRANSPORT')
  if (transport === 'fetch' || transport === 'plugin-http' || transport === 'auto') {
    next.http.transport = transport
  }
  const multimodalBase = nodeEnv('LU_MULTIMODAL_BASE_URL')
  if (multimodalBase && multimodalBase.trim()) next.multimodal.baseUrl = multimodalBase.trim().replace(/\/+$/, '')
  return next
}

/** 持久化时剥离密钥字段（密钥只进 secrets 适配器，D-19/F-17） */
export function stripSecrets(config: AppConfig): Record<string, unknown> {
  // 防御：config 在某些调用路径下可能被 Vue reactive 包裹（如 TaskManager 存入 ref 时），
  // structuredClone 对 reactive Proxy 会抛 "could not be cloned"。JSON 往返可安全穿透 Proxy 得到纯对象。
  let clone: AppConfig
  try {
    clone = JSON.parse(JSON.stringify(config)) as AppConfig
  } catch {
    clone = structuredClone(config)
  }
  clone.mineru.token = ''
  clone.multimodal.apiKey = ''
  return clone as unknown as Record<string, unknown>
}

export interface LoadConfigDeps {
  store: ConfigStore
  secrets: SecretsAdapter
}

/**
 * 完整加载：默认值 < 持久化 < 环境变量 < 密钥注入。
 * 密钥注入失败（如 DPAPI 不可用）不阻塞启动，token 置空并在日志可见。
 */
export async function loadConfig(deps: LoadConfigDeps): Promise<AppConfig> {
  let persisted: Record<string, unknown> | null = null
  try {
    persisted = await deps.store.read()
  } catch {
    persisted = null
  }
  let config = normalizeConfig(persisted)
  config = applyEnvOverrides(config)

  try {
    const raw = (await deps.secrets.get(SECRET_KEYS.mineruToken)) ?? ''
    const clean = sanitizeToken(raw)
    if (clean !== raw.trim()) log('warn', 'config', 'token.sanitized', { removed: raw.length - clean.length })
    config.mineru.token = clean
  } catch {
    config.mineru.token = ''
  }
  try {
    const raw = (await deps.secrets.get(SECRET_KEYS.multimodalApiKey)) ?? ''
    const clean = sanitizeToken(raw)
    if (clean !== raw.trim()) log('warn', 'config', 'apiKey.sanitized', { removed: raw.length - clean.length })
    config.multimodal.apiKey = clean
  } catch {
    config.multimodal.apiKey = ''
  }
  log('info', 'config', 'load.done', {
    // D-93：启动快照——排障时首先需要确认「生效的是哪套配置 / 哪个环境」
    version: appVersion(),
    os: osLabel(),
    transport: config.http.transport,
    baseUrl: maskUrl(config.mineru.baseUrl),
    agentBaseUrl: maskUrl(config.mineru.agentBaseUrl),
    apiMode: config.mineru.apiMode,
    modelVersion: config.mineru.parse.modelVersion,
    // D-94：图片描述服务是否就绪必须可见——此前只记 MinerU，多模态留空时无从判断
    multimodalBaseUrl: maskUrl(config.multimodal.baseUrl) || '(empty)',
    multimodalModel: config.multimodal.model || '(empty)',
    hasMultimodalKey: Boolean(config.multimodal.apiKey),
    hasToken: Boolean(config.mineru.token),
    tokenSavedAt: config.mineru.tokenSavedAt || null,
    debugEnabled: config.logging.debugEnabled,
    maxSizeMB: config.logging.maxSizeMB,
  })
  return config
}

/** 持久化非密配置 */
export async function saveConfig(deps: LoadConfigDeps, config: AppConfig): Promise<void> {
  log('info', 'config', 'save', { debugEnabled: config.logging.debugEnabled, maxSizeMB: config.logging.maxSizeMB })
  await deps.store.write(stripSecrets(config))
}

// M11 · core/types — 跨模块唯一契约来源
// 边界规则（plan/01 §五 规则 5）：core/types 是唯一跨模块契约来源，禁止模块间隐式传 any。
// 字段依据：plan/04 P-2（云端 v4 契约）、OT-X346~352（models）、R3/R4 待回查项在注释中标注。

// ---------------------------------------------------------------- 配置（M01）

/** HTTP 传输层选型；'auto' = Tauri 内用 plugin-http，Node 内用 fetch（T1-03 结论，见完成报告） */
export type HttpTransportKind = 'auto' | 'fetch' | 'plugin-http'

/** MinerU 解析选项 → file-urls/batch 请求体字段（OT-X 实证：client.py:266-276） */
export interface ParseOptions {
  isOcr: boolean
  enableTable: boolean
  enableFormula: boolean
  language: string
  modelVersion: string
  /** '' = 全量；形如 "1-10,15"（Agent 模式仅支持单段，如 "1-20"） */
  pageRanges: string
  /** 附加导出格式（docx / html / latex；Markdown+JSON 为默认产物） */
  extraFormats: string[]
  /** 是否保留 JSON 产物（MinerU zip 自带；选中时按完整产物落盘） */
  includeJson: boolean
}

/** 解析模式：precise = 精准解析 API（需 Token）；agent = Agent 轻量解析 API（免 Token，IP 限频） */
export type MineruApiMode = 'precise' | 'agent'

export interface MinerUConfig {
  /** 默认 https://mineru.net/api/v4；D-28：从配置读取，代码无硬编码端点常量 */
  baseUrl: string
  /** Agent 轻量解析 API 根地址（免 Token） */
  agentBaseUrl: string
  /** 当前解析模式（精准 / Agent 轻量） */
  apiMode: MineruApiMode
  /** Token 最近一次保存时间（ms）；0 = 未记录。用于「90 天需重新申请」计时 */
  tokenSavedAt: number
  /** 由 secrets 适配器注入，不明文落盘（D-19 / F-17） */
  token: string
  requestTimeoutMs: number
  taskTimeoutMs: number
  pollIntervalMs: number
  verifySsl: boolean
  maxAttempts: number
  parse: ParseOptions
}

/** 图片描述提示词方案：内置 4 套（id 稳定短名）+ 用户自定义（id 以 `User` 前缀） */
export interface PromptPreset {
  id: string
  name: string
  content: string
}

/** 多模态组（阶段 2 使用；D-20：默认 OpenAI 兼容 + 空端点 + 用户自填） */
export interface MultimodalConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 当前生效的提示词方案 id（内置 general/academic/office/ui 或用户方案 User-*） */
  activePromptId: string
  /** 用户自定义提示词方案（与内置方案隔离存储） */
  customPrompts: PromptPreset[]
  /** 图片描述并发数（T2-03；TS-X006 实证默认 4；T2-10 暴露到设置页） */
  concurrency: number
  /** 单次调用超时 ms（T2-01 模块常量提升，T2-10） */
  timeoutMs: number
  /** 单张调用最大尝试次数（T2-01 模块常量提升，T2-10） */
  maxAttempts: number
  /** 单次运行的调用上限（0 = 不限；需求 §四 防费用失控，T2-10） */
  maxImages: number
  /** 图片 URL 形态（T2-01 模块常量提升，T2-10） */
  imageUrlForm: 'data-uri' | 'raw-base64'
  /** 描述长度硬顶（T2-05 模块常量提升，T2-10） */
  maxDescriptionChars: number
}

/** ZIP 解包三重限额（OT-X047 / OT-C050~052 实证默认值） */
export interface LimitsConfig {
  maxZipEntries: number
  maxZipTotalBytes: number
  maxZipFileBytes: number
}

/** 输出格式（T5-05/D-61）：markdown=仅 full.md；all=full.md + JSON + images 完整产物 */
export type OutputFormat = 'markdown' | 'all'

/**
 * D-98：输出内容多选项（取代原「仅 Markdown / 全部文件」二选一）。
 * 'all' 不作为存储值——它是「全选」的界面语义，等价于五项全选。
 */
export type OutputKind = 'markdown' | 'json' | 'docx' | 'html' | 'images'
/** 图片描述写入方式（T2-08/T2-09/D-34）：replace=整段替换引用；both=保留引用+旁注 */
export type CaptionWriteMode = 'replace' | 'both'
/** 同名输出目录处理（T5-02/D-62）：suffix=追加 _N 序号（现状）；overwrite=覆盖同名目录 */
export type SameNameHandling = 'suffix' | 'overwrite'

/** 日志系统配置（轮 G 日志重构 / T4 派生）：调试日志默认关闭，按需开启；目录总容量上限滚动清理 */
export interface LoggingConfig {
  /** 调试日志开关：false = 仅 warn/error 落盘（默认，避免大文件）；true = 全量 trace/debug/info 落盘 */
  debugEnabled: boolean
  /** 调试日志目录总容量上限（MB）；超限滚动删除最旧文件（默认 50） */
  maxSizeMB: number
}

/** 单入口输出行为配置（右键 / 工作站各自独立，T5-02/D-62） */
export interface OutputEntryConfig {
  /** 默认输出目录；空串 = 源文件同目录（右键）/ 用户指定工作区（工作站） */
  defaultDir: string
  format: OutputFormat
  /** D-98：输出内容多选（源数据）；format 由它派生，供旧调用点使用 */
  outputs: OutputKind[]
  captionMode: CaptionWriteMode
  /** 完成后自动打开输出目录 */
  autoOpen: boolean
  /** 图片描述默认启用（轮 H：由「图片描述」组迁移而来；每个入口独立控制，作为该入口的默认值；后续可在文件/任务级单独覆盖） */
  captionEnabled: boolean
}

/** 入口行为分流（D-15/D-17）：右键=源目录无额外动作；主工作站=完整流程 */
export interface OutputConfig {
  entry: 'workbench' | 'context-menu'
  /** workbench 模式输出根目录；context-menu 模式忽略，用源文件所在目录 */
  outputDir: string
  /** D-31（覆盖 D-25）：完成后默认不自动打开输出目录；设置可改 */
  onComplete: 'open-dir' | 'open-file' | 'none'
  /** T4-06：轻量进度窗（右键入口使用的独立进度窗）完成后是否自动关闭（默认 true，可配置为保留） */
  autoCloseProgress: boolean
  /** T5-02/D-62：右键入口输出行为 */
  rightClick: OutputEntryConfig
  /** T5-02/D-62：工作站入口输出行为 */
  workbench: OutputEntryConfig
  /** T5-02/D-62：同名输出目录处理（两入口通用） */
  sameNameHandling: SameNameHandling
}

export interface AppConfig {
  mineru: MinerUConfig
  multimodal: MultimodalConfig
  http: { transport: HttpTransportKind }
  limits: LimitsConfig
  output: OutputConfig
  /** 阶段 3 任务队列与重试配置（T3-06/07） */
  tasks: TaskConfig
  /** 轮 G 日志重构：调试日志开关 + 容量上限（T4 派生） */
  logging: LoggingConfig
}

// ---------------------------------------------------------------- 客户端（M02）

/** 服务端 state 归一后的云端状态（plan/04 P-1 state 全集） */
export type CloudState = 'pending' | 'running' | 'done' | 'failed' | 'unknown'

export interface TaskStatus {
  taskId: string
  batchId: string
  state: CloudState
  message: string
  /** full_zip_url（done 时出现） */
  resultUrl: string | null
  markdownUrl: string | null
  extractedPages: number | null
  totalPages: number | null
  raw: Record<string, unknown>
}

export interface FileUrlsRequest {
  fileName: string
  parse: ParseOptions
}

export interface FileUrlsResult {
  batchId: string
  uploadUrl: string
}

// ---------------------------------------------------------------- 输出（M05）

export interface ExtractedFile {
  /** 相对路径（已做路径穿越清洗） */
  path: string
  data: Uint8Array
}

export interface ExtractedOutputs {
  files: ExtractedFile[]
  markdownFiles: string[]
  jsonFiles: string[]
  imageFiles: string[]
}

export interface WriteResult {
  outputDir: string
  markdownPath: string | null
}

// ---------------------------------------------------------------- 流水线（M03）

export type PipelinePhase =
  | 'validating'
  | 'reading'
  | 'uploading'
  | 'polling'
  | 'downloading'
  | 'extracting'
  | 'writing'
  | 'done'
  | 'failed'
  | 'canceled'

export interface PipelineEvent {
  type: 'phase' | 'log' | 'progress'
  phase?: PipelinePhase
  message?: string
  extractedPages?: number
  totalPages?: number
}

export type PipelineCallback = (event: PipelineEvent) => void

export interface PipelineInput {
  filePath: string
}

export interface PipelineResult {
  outputDir: string
  markdownPath: string | null
  batchId: string
  taskId: string
  durationMs: number
}

// ---------------------------------------------------------------- 任务（M06）

export type JobStatus =
  | 'pending'
  | 'uploading'
  | 'polling'
  | 'downloading'
  | 'extracting'
  | 'writing'
  | 'done'
  | 'failed'
  | 'canceled'
  /** T3-07 崩溃恢复：进程异常退出后重启，未终态任务标记为 interrupted（可恢复，用户重试） */

  | 'interrupted'

export interface Job {
  id: string
  inputPath: string
  status: JobStatus
  createdAt: number
  updatedAt: number
  error: string | null
  /** 失败/取消的错误类别（T1-09 四类 + canceled/unsupported），供 UI 区分提示 */
  errorKind: BmuErrorKind | null
  outputDir: string | null
  batchId: string | null
  /** T3-06 重试计数（落库，递增；达到上限后不可再重试） */
  retryCount: number
  /** D-43：完成后生成的 full.md 路径（FileList「打开」直达；store task_files.markdown_path） */
  markdownPath?: string
  /** D-42：期望的输出目录覆盖（行内修改/解析到…设置）；下次执行作为 pipeline destDirOverride 传入 */
  destDirOverride?: string
}

/** T3-06/07 任务队列与重试配置组（阶段 3 新增） */
export interface TaskConfig {
  /** 失败自动重试上限；0 = 不自动重试（仅手动重试可达上限） */
  maxRetries: number
  /** 队列并发（mineru.net 账号额度制，默认 1 顺序执行；OT-C011） */
  queueConcurrency: number
  /** 崩溃恢复：未终态任务超过此时长（ms）判定 stale 并转 failed（T3-07） */
  staleTimeoutMs: number
  /** T4-04/D-38：导入后是否自动开始（false = 手动点「开始」；true = 导入即跑） */
  autoStart: boolean
}

export interface JobEvent {
  jobId: string
  event: PipelineEvent
  at: number
}

// ---------------------------------------------------------------- 错误分类（plan/04 P-2）

/**
 * 四类 API 错误可区分（T1-09）：
 * - auth     认证错误（A0202 Token 错误 / A0211 Token 过期 / HTTP 401/403）——不重试
 * - limit    超限错误（-60005 >200MB / -60006 >200 页 / -60018 每日额度）——不重试，触发拆分提示
 * - transport 传输错误（网络失败 / 超时 / 429 / 5xx）——按退避重试
 * - business 业务错误（其余 code != 0，如 -60001/-60008/-60009/-60012/-60013/-60017）
 * 另有两类本地守卫：canceled（取消）、unsupported（非 PDF 输入，D-14）。
 */
export type BmuErrorKind = 'auth' | 'limit' | 'transport' | 'business' | 'canceled' | 'unsupported' | 'internal'

// M02 · core/client/multimodal — OpenAI 兼容多模态图片描述客户端（T2-01）
// 契约依据：
//   TS-X003/004/005（天枢 ImageCaptioner，openai SDK 语义）：chat/completions、
//     user[text + image_url(data URI)]、choices[0].message.content、描述一行化清洗。
//   VS-X016/017（Visuals call_glm_vision）：system(固定) + user[text(固定), image(变化)] 双段结构、
//     temperature=0 / max_tokens=4096、120s 超时、3 次重试、裸 base64（不加 data URI 前缀）形态。
//   D-20：默认 OpenAI 兼容协议 + 空端点/用户自填，不绑死厂商。
// 复用 T1-05 统一 HTTP 封装（core/platform/http.ts），不新增 HTTP 库（D-07 同精神）。
// MIT License — 逻辑改编自 mineru-tianshu（Apache 2.0，保留版权声明）与 Visuals-Skill；
//   许可证经 D-29 用户确认；按 D-07 以 TypeScript 重写。

import { BmuError, isBmuError } from './errors'
import { defaultShouldRetry, withRetry } from './retry'
import { maskSecretsInText } from './logmask'
import type { HttpTransport, HttpTransportError, HttpResponseLike } from '../platform/http'
import type { AppConfig } from '../types'

/** VS-X017 实证默认值（T2-04 退避参数、T2-10 配置键集落地前先用模块常量） */
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TEMPERATURE = 0

const STAGE = 'chat/completions'

/** 图片扩展名 → MIME（TS-X003 MIME_TYPES 同表；缺省兜底 image/jpeg） */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
}

/**
 * 图片 URL 形态：
 * - 'data-uri'：`data:{mime};base64,{b64}`（OpenAI 标准，TS-X003 实证，默认）
 * - 'raw-base64'：裸 base64 字符串（VS-X016：glm-4.6v-flash 官方文档要求，不加 data URI 前缀）
 */
export type ImageUrlForm = 'data-uri' | 'raw-base64'

export interface CaptionRequest {
  /** 图片字节（调用方读取，TS-X003：client 只负责编码） */
  image: Uint8Array
  /** 图片文件名（推断 MIME；缺省按 image/jpeg） */
  fileName?: string
  /** 用户段 Prompt（T2-02 的 USER 常量或 customPrompt 覆盖值） */
  prompt: string
  /** 系统段 Prompt（T2-02 的 SYSTEM 常量；空则不发送 system 消息） */
  systemPrompt?: string
}

export interface CaptionUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface CaptionResult {
  /** 清洗后的描述文本（一行化 + 双引号替换，TS-X005） */
  text: string
  usage?: CaptionUsage
}

export interface MultimodalClientOptions {
  config: AppConfig
  transport: HttpTransport
  onLog?: (message: string) => void
  /** 单次调用超时（默认 120s，VS-X017 http_timeout 实证） */
  timeoutMs?: number
  /** 最大尝试次数（默认 3，VS-X017 http_retries 实证） */
  maxAttempts?: number
  /** max_tokens（默认 4096，VS-X017） */
  maxTokens?: number
  /** temperature（默认 0，VS-X017：保证输出确定性） */
  temperature?: number
  /** 图片 URL 形态（默认 data-uri） */
  imageUrlForm?: ImageUrlForm
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
}

/** Uint8Array → base64（Node 走 Buffer；WebView 走分块 btoa，避免大图 spread 爆栈） */
export function toBase64(bytes: Uint8Array): string {
  const bufferCtor = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(enc: string): string } } }).Buffer
  if (bufferCtor) return bufferCtor.from(bytes).toString('base64')
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/** 文件名 → MIME（TS-X003 同表；无扩展名或未知类型兜底 image/jpeg） */
export function mimeOf(fileName: string | undefined): string {
  if (!fileName) return 'image/jpeg'
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  return MIME_BY_EXT[ext] ?? 'image/jpeg'
}

/** 描述清洗（TS-X005 实证）：一行化（去换行/连续空白）+ 双引号替换，避免破坏 Markdown/HTML 结构 */
export function cleanCaption(text: string): string {
  return text.trim().split(/\s+/).join(' ').replace(/"/g, "'")
}

/** 构造 chat/completions 请求体（双段结构：system 固定段在前 + user[text, image]；systemPrompt 唯一来源为 req） */
export function buildChatPayload(
  req: CaptionRequest,
  opts: { model: string; maxTokens: number; temperature: number; imageUrlForm: ImageUrlForm },
): Record<string, unknown> {
  const b64 = toBase64(req.image)
  const imageUrl = opts.imageUrlForm === 'raw-base64' ? b64 : `data:${mimeOf(req.fileName)};base64,${b64}`
  const messages: Array<Record<string, unknown>> = []
  const system = (req.systemPrompt ?? '').trim()
  if (system) messages.push({ role: 'system', content: system })
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: req.prompt },
      { type: 'image_url', image_url: { url: imageUrl } },
    ],
  })
  return {
    model: opts.model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  }
}

/** 解析 choices[0].message.content；缺失/为空按业务错误处理（T2-01 验收：返回描述字符串） */
export function parseCaptionResponse(resp: HttpResponseLike): CaptionResult {
  let parsed: unknown
  try {
    parsed = resp.json<unknown>()
  } catch {
    throw new BmuError('business', `多模态 API 返回无效 JSON（HTTP ${resp.status}，${STAGE}）。`, {
      code: 'INVALID_JSON', stage: STAGE,
    })
  }
  const p = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const choices = Array.isArray(p.choices) ? p.choices : []
  const first = choices.length > 0 && typeof choices[0] === 'object' && choices[0] !== null ? (choices[0] as Record<string, unknown>) : {}
  const message = typeof first.message === 'object' && first.message !== null ? (first.message as Record<string, unknown>) : {}
  const content = message.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new BmuError('business', '多模态响应缺少描述内容（choices[0].message.content 为空或非字符串）。', {
      code: 'EMPTY_CAPTION', stage: STAGE,
    })
  }
  return { text: cleanCaption(content), usage: parseUsage(p.usage) }
}

function parseUsage(raw: unknown): CaptionUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const u = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const usage: CaptionUsage = {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  }
  const empty = usage.promptTokens === undefined && usage.completionTokens === undefined && usage.totalTokens === undefined
  return empty ? undefined : usage
}

/**
 * 传输层错误文案改写：共享传输层（T1-05）的 429/5xx 文案是 mineru 口径，
 * 多模态场景只改厂商名；同时遮蔽配置中的 API Key（供应商错误文案可能回显密钥，T2-14）。
 * kind/code/retryable 等分类语义不变。
 */
function remapMultimodalError(err: unknown, apiKey: string): unknown {
  if (!isBmuError(err)) return err
  const message = maskSecretsInText(err.message.replace(/mineru\.net/g, '多模态 API'), [apiKey])
  if (message === err.message) return err
  return new BmuError(err.kind, message, {
    code: err.code, stage: err.stage, attempts: err.attempts, retryable: err.retryable, cause: err,
  })
}

export class MultimodalClient {
  private readonly config: AppConfig
  private readonly transport: HttpTransport
  private readonly onLog: (message: string) => void
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly maxTokens: number
  private readonly temperature: number
  private readonly imageUrlForm: ImageUrlForm

  constructor(opts: MultimodalClientOptions) {
    this.config = opts.config
    this.transport = opts.transport
    this.onLog = opts.onLog ?? (() => undefined)
    // T2-10：优先级 = 构造参数 > 配置（config.multimodal.*）> 模块常量兜底
    const mm = opts.config.multimodal
    this.timeoutMs = opts.timeoutMs ?? mm?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxAttempts = opts.maxAttempts ?? mm?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
    this.temperature = opts.temperature ?? DEFAULT_TEMPERATURE
    this.imageUrlForm = opts.imageUrlForm ?? mm?.imageUrlForm ?? 'data-uri'
  }

  /**
   * 单张图片描述（T2-01 验收：返回描述字符串；4xx/超时抛可分类错误）。
   * - 配置缺失：base_url/api_key/model 分别抛 business/auth 类错误（不重试）
   * - 传输错误：429/5xx/网络按退避重试（T1-08 同款 withRetry）；401/403 归认证不重试
   * - 响应异常：无效 JSON / 空 content 归业务错误
   * 注意：图片描述开关（入口级 captionEnabled / 调用级覆盖）由调用层控制，本客户端不拦截。
   */
  async caption(req: CaptionRequest, signal?: AbortSignal): Promise<CaptionResult> {
    const { baseUrl, apiKey, model } = this.config.multimodal
    if (!baseUrl.trim()) {
      throw new BmuError('business', '未配置多模态 API 地址（base_url 为空）——请在设置页图片描述组填写。', {
        code: 'NO_BASE_URL', stage: STAGE, retryable: false,
      })
    }
    if (!apiKey.trim()) {
      throw new BmuError('auth', '未配置多模态 API Key——请在设置页图片描述组填写。', {
        code: 'NO_API_KEY', stage: STAGE, retryable: false,
      })
    }
    if (!model.trim()) {
      throw new BmuError('business', '未配置多模态模型名（model 为空）——请在设置页图片描述组填写。', {
        code: 'NO_MODEL', stage: STAGE, retryable: false,
      })
    }
    if (!req.prompt.trim()) {
      throw new BmuError('business', '图片描述 Prompt 为空——请检查 Prompt 配置（T2-02）。', {
        code: 'NO_PROMPT', stage: STAGE, retryable: false,
      })
    }

    const payload = buildChatPayload(req, {
      model,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      imageUrlForm: this.imageUrlForm,
    })
    const url = joinUrl(baseUrl, '/chat/completions')
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }

    let resp: HttpResponseLike
    try {
      resp = await withRetry(
        async () =>
          this.transport.request({
            url,
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            timeoutMs: this.timeoutMs,
            signal,
          }),
        {
          maxAttempts: this.maxAttempts,
          stage: STAGE,
          signal,
          shouldRetry: defaultShouldRetry,
          retryAfterOf: (err) => (err as HttpTransportError).retryAfter ?? null,
          onRetry: (attempt, delay, err) =>
            this.onLog(`多模态描述重试 ${attempt}/${this.maxAttempts}（${err.kind}，${delay.toFixed(1)}s 后）`),
        },
      )
    } catch (err) {
      throw remapMultimodalError(err, apiKey)
    }
    return parseCaptionResponse(resp)
  }
}

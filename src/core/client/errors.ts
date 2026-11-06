// M02 · core/client/errors — 四类 API 错误分类（T1-09）
// 依据 plan/04 P-2 错误码表；code 提示文案参照 OT-X（client.py:233-237 _CLOUD_CODE_HINTS）。

import type { BmuErrorKind } from '../types'

export interface BmuErrorOptions {
  code?: string
  stage?: string
  attempts?: number
  retryable?: boolean
  cause?: unknown
  /** D-93：HTTP 数值状态码（与 code 分离——code 可能是业务码 A0202 或 HTTP_403） */
  httpStatus?: number
  /** D-93：服务端响应体片段（非 JSON 时尤为关键，如网关 "Invalid CORS request"） */
  bodySnippet?: string
}

export class BmuError extends Error {
  readonly kind: BmuErrorKind
  readonly code: string | undefined
  readonly stage: string | undefined
  readonly attempts: number | undefined
  readonly retryable: boolean
  readonly httpStatus: number | undefined
  readonly bodySnippet: string | undefined

  constructor(kind: BmuErrorKind, message: string, opts: BmuErrorOptions = {}) {
    super(message)
    this.name = 'BmuError'
    this.kind = kind
    this.code = opts.code
    this.stage = opts.stage
    this.attempts = opts.attempts
    this.retryable = opts.retryable ?? kind === 'transport'
    this.httpStatus = opts.httpStatus
    this.bodySnippet = opts.bodySnippet
    if (opts.cause !== undefined) (this as Error & { cause?: unknown }).cause = opts.cause
  }
}

export function isBmuError(err: unknown): err is BmuError {
  return err instanceof BmuError
}

// ---------------------------------------------------------------- 错误码表（plan/04 P-2）

const AUTH_CODES = new Set(['A0202', 'A0211'])
const LIMIT_CODES = new Set(['-60005', '-60006', '-60018'])

/** 官方错误码 → 用户可读提示（OT-X _CLOUD_CODE_HINTS 同义） */
export const CODE_HINTS: Record<string, string> = {
  '-60005': '文件超过官方 API 单文件 200 MB 上限，请拆分后再试。',
  '-60006': '文件超过官方 API 单文件 200 页上限，请用页码范围分批解析（阶段 3 将自动拆分合并）。',
  '-60018': '当日任务量已达上限（每账户每天 1000 页最高优先级，超出部分降级排队）。',
  '-60001': '申请上传 URL 失败，请稍后重试。',
  '-60008': 'URL 读取超时，请稍后重试。',
  '-60009': '云端队列已满，请稍后重试。',
  '-60012': '任务不存在（可能已过期），请重新提交。',
  '-60013': '无权限访问该任务。',
  '-60017': '已达重试上限，请稍后重试。',
}

export function isAuthCode(code: string): boolean {
  return AUTH_CODES.has(code)
}

export function isLimitCode(code: string): boolean {
  return LIMIT_CODES.has(code)
}

/** 从响应信封提取业务码（兼容 code / err_code 两种字段名，OT-X095/110 实证） */
export function extractEnvelopeCode(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  const raw = p.code ?? p.err_code
  if (raw === undefined || raw === null) return null
  return String(raw)
}

/** 信封是否表示成功（0 / "0" / 200 / null，OT-X204-206 实证） */
export function isEnvelopeSuccess(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  if (p.success === false) return false
  const code = extractEnvelopeCode(payload)
  if (code === null) return true
  return code === '0' || code === '200' || code === '0'
    || code.toLowerCase() === 'ok' || code.toLowerCase() === 'success'
}

/** 提取信封消息（msg / message / error，OT-X201 实证顺序） */
export function extractEnvelopeMessage(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const p = payload as Record<string, unknown>
  const msg = p.msg ?? p.message ?? p.error
  return typeof msg === 'string' ? msg : ''
}

/**
 * HTTP 状态 + 响应体 → 分类错误（T1-09 验收：A0202/A0211 归认证且不重试；
 * -60005/-60006 归超限；网络超时归传输并按退避重试）。
 */
export function classifyHttpFailure(
  status: number,
  payload: unknown,
  ctx: { stage: string; attempts?: number; bodySnippet?: string },
): BmuError {
  const code = extractEnvelopeCode(payload)
  const msg = extractEnvelopeMessage(payload)
  // D-93：每个分类结果都带上 HTTP 状态与响应体片段，供上层日志统一落盘（此前只留 code，正文丢失）
  const meta = { httpStatus: status, bodySnippet: ctx.bodySnippet }

  if (code !== null && isAuthCode(code)) {
    return new BmuError('auth', `MinerU Token 无效或已过期（${code}）——请到 mineru.net「API 管理」页重新生成后填入。${msg}`, {
      code, stage: ctx.stage, attempts: ctx.attempts, retryable: false, ...meta,
    })
  }
  if (status === 401 || status === 403) {
    // D-92：403 且无业务错误码 = 网关/WAF 在鉴权层之前拒绝（如 CORS、代理拦截），
    // 与 token 无关；MinerU 对无效 token 实际返回 401 + A0202，故两种情况必须区分，否则会误导排查。
    if (status === 403 && code === null) {
      return new BmuError('auth', `请求被 mineru.net 网关拒绝（HTTP 403${msg ? `：${msg}` : ''}）——非 Token 问题，通常是代理/防火墙拦截或客户端附加了不被允许的请求头。`, {
        code: 'HTTP_403', stage: ctx.stage, attempts: ctx.attempts, retryable: false, ...meta,
      })
    }
    return new BmuError('auth', `认证失败（HTTP ${status}${code ? ` ${code}` : ''}）——请检查 Token 是否有效。${msg}`, {
      code: code ?? `HTTP_${status}`, stage: ctx.stage, attempts: ctx.attempts, retryable: false, ...meta,
    })
  }
  if (code !== null && isLimitCode(code)) {
    const hint = CODE_HINTS[code] ?? ''
    return new BmuError('limit', `MinerU 云端限制（${code}）：${msg}${hint ? ` — ${hint}` : ''}`, {
      code, stage: ctx.stage, attempts: ctx.attempts, retryable: false, ...meta,
    })
  }
  if (status === 429 || status >= 500) {
    return new BmuError('transport', `mineru.net HTTP ${status}${msg ? `：${msg}` : ''}`, {
      code: code ?? `HTTP_${status}`, stage: ctx.stage, attempts: ctx.attempts, retryable: true, ...meta,
    })
  }
  const hint = code !== null ? (CODE_HINTS[code] ?? '') : ''
  return new BmuError('business', `mineru.net 业务错误${code ? ` ${code}` : ` HTTP ${status}`}：${msg}${hint ? ` — ${hint}` : ''}`, {
    code: code ?? `HTTP_${status}`, stage: ctx.stage, attempts: ctx.attempts, retryable: false, ...meta,
  })
}

/** 网络层异常（fetch reject / 超时 / 中止）→ transport 或 canceled */
export function classifyNetworkFailure(err: unknown, ctx: { stage: string; attempts?: number }): BmuError {
  const name = (err as { name?: string } | undefined)?.name
  if (name === 'AbortError' || name === 'CanceledError') {
    return new BmuError('canceled', '任务已取消。', { stage: ctx.stage, attempts: ctx.attempts })
  }
  const detail = err instanceof Error ? err.message : String(err)
  return new BmuError('transport', `网络错误（${ctx.stage}）：${detail}`, {
    stage: ctx.stage, attempts: ctx.attempts, retryable: true, cause: err,
  })
}

/** 未知异常 → internal */
export function classifyUnknownFailure(err: unknown, ctx: { stage: string }): BmuError {
  if (isBmuError(err)) return err
  const detail = err instanceof Error ? err.message : String(err)
  return new BmuError('internal', `内部错误（${ctx.stage}）：${detail}`, { stage: ctx.stage, cause: err })
}

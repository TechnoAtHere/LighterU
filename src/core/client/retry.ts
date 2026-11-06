// M02 · core/client/retry — 指数退避 + Retry-After 尊重（T1-08）
// 语义照搬 OT-X029~033（client.py:226-247 _cloud_backoff_seconds）：min(16, 2^(attempt-1))，
// 收到 Retry-After 时 min(60, max(delay, retry_after))。
// MIT License — 改编自 MinerU-OCR-Tool（src/mineru_ocr_tool/client.py:240-247，
// 许可证经 D-29 用户确认为 MIT；保留原始版权声明与 LICENSE）。

import { BmuError, classifyNetworkFailure } from './errors'
import type { BmuErrorKind } from '../types'

export const BACKOFF_CAP_SECONDS = 16
export const RETRY_AFTER_CAP_SECONDS = 60

export function cloudBackoffSeconds(attempt: number, retryAfter?: string | null): number {
  const delay = Math.min(BACKOFF_CAP_SECONDS, Math.pow(2, attempt - 1))
  if (retryAfter) {
    const ra = Number(retryAfter)
    if (Number.isFinite(ra) && ra > 0) {
      return Math.min(RETRY_AFTER_CAP_SECONDS, Math.max(delay, ra))
    }
  }
  return delay
}

export interface RetryOptions<T> {
  maxAttempts: number
  /** 返回 true 才重试；默认仅 transport 类 */
  shouldRetry?: (err: BmuError, attempt: number) => boolean
  signal?: AbortSignal
  stage: string
  backoffSeconds?: (attempt: number, retryAfter: string | null) => number
  onRetry?: (attempt: number, delaySeconds: number, err: BmuError) => void
  /** 从错误对象上取 Retry-After（由传输层写入） */
  retryAfterOf?: (err: BmuError) => string | null
  _last?: T
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BmuError('canceled', '任务已取消。', { stage: 'retry-sleep' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new BmuError('canceled', '任务已取消。', { stage: 'retry-sleep' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 带退避的执行器。fn 收到的 attempt 从 1 开始；
 * 认证/超限/业务错误不重试（T1-09）；取消立即抛出不重试。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions<T>,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts)
  const shouldRetry = opts.shouldRetry ?? ((err: BmuError) => err.kind === 'transport')
  const backoff = opts.backoffSeconds ?? cloudBackoffSeconds
  let lastError: BmuError | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new BmuError('canceled', '任务已取消。', { stage: opts.stage, attempts: attempt })
    }
    try {
      return await fn(attempt)
    } catch (rawErr) {
      const err = rawErr instanceof BmuError ? rawErr : classifyNetworkFailure(rawErr, { stage: opts.stage, attempts: attempt })
      if (err.kind === 'canceled') throw err
      lastError = err
      const canRetry = attempt < maxAttempts && shouldRetry(err, attempt)
      if (!canRetry) {
        throw new BmuError(err.kind, err.message, {
          code: err.code,
          stage: opts.stage,
          attempts: attempt,
          retryable: false,
          cause: rawErr,
          // D-93：重建错误时必须保留 HTTP 状态与响应体片段，否则上层日志/提示丢失关键证据
          httpStatus: err.httpStatus,
          bodySnippet: err.bodySnippet,
        })
      }
      const retryAfter = opts.retryAfterOf?.(err) ?? null
      const delaySeconds = backoff(attempt, retryAfter)
      opts.onRetry?.(attempt, delaySeconds, err)
      await sleep(delaySeconds * 1000, opts.signal)
    }
  }
  throw lastError ?? new BmuError('internal', '重试耗尽。', { stage: opts.stage })
}

/** 默认重试判定：仅传输类（429/5xx/网络）重试；auth/limit/business 不重试 */
export function defaultShouldRetry(err: BmuError): boolean {
  const kinds: BmuErrorKind[] = ['transport']
  return kinds.includes(err.kind)
}

// platform · HTTP 传输抽象（T1-05 统一封装层）
// T1-03 结论：mineru.net 无 CORS 响应头且预检 OPTIONS 返回 405（见完成报告证据 A/B/C），
// WebView 内 fetch 必被 CORS 拦截 → Tauri 内默认走 @tauri-apps/plugin-http（Rust reqwest，无 CORS）；
// Node（dev-only 无头入口）无 CORS 概念，用全局 fetch。两种实现由此层隔离，调用方无感。

import { BmuError, classifyHttpFailure, classifyNetworkFailure, isBmuError } from '../client/errors'
import { isTauri } from './env'
import type { HttpTransportKind } from '../types'
import { log as blog, maskUrl } from './logger'

export interface HttpRequestSpec {
  url: string
  method: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
  body?: Uint8Array | string
  timeoutMs: number
  signal?: AbortSignal
}

export interface HttpResponseLike {
  status: number
  /** 统一小写键 */
  headers: Record<string, string>
  body: Uint8Array
  text(): string
  json<T>(): T
}

export interface HttpTransport {
  readonly kind: 'fetch' | 'plugin-http'
  request(spec: HttpRequestSpec): Promise<HttpResponseLike>
}

/** 传输层错误上附带 Retry-After，供退避重试读取 */
export interface HttpTransportError extends BmuError {
  retryAfter?: string | null
}

function toHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

function makeResponse(status: number, headers: Headers, body: Uint8Array): HttpResponseLike {
  let cachedText: string | null = null
  return {
    status,
    headers: toHeaders(headers),
    body,
    text(): string {
      if (cachedText === null) cachedText = new TextDecoder('utf-8').decode(body)
      return cachedText
    },
    json<T>(): T {
      return JSON.parse(this.text()) as T
    },
  }
}

function safeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(body))
  } catch {
    return undefined
  }
}

/**
 * D-92：保留非 JSON 响应体片段用于诊断。
 * 网关/WAF 拒绝（如 `403 Invalid CORS request`、HTML 拦截页）返回纯文本，
 * 旧实现只抛 `HTTP_403` 而丢弃正文，导致「Token 正确却 403」无法定位。
 */
function describeBody(body: Uint8Array): unknown {
  const parsed = safeJson(body)
  if (parsed !== undefined) return parsed
  const text = new TextDecoder('utf-8').decode(body).trim()
  return text ? { msg: text.slice(0, 240) } : undefined
}

/** D-93：响应体原文片段（无论 JSON 与否都截断保留，落盘用；最多 240 字符） */
function bodyText(body: Uint8Array): string {
  if (body.length === 0) return ''
  return new TextDecoder('utf-8').decode(body).trim().slice(0, 240)
}

/** D-93：请求头名清单（只记名字、不记值，避免密钥/签名入日志） */
function headerNames(headers: Record<string, string> | undefined): string {
  return Object.keys(headers ?? {}).sort().join(',')
}

/** Uint8Array → ArrayBuffer（fetch BodyInit 需要 BufferSource；复制避免缓冲 detachment） */
function toBody(body: Uint8Array | string | undefined): BodyInit | undefined {
  if (body === undefined) return undefined
  if (typeof body === 'string') return body
  const copy = new ArrayBuffer(body.byteLength)
  new Uint8Array(copy).set(body)
  return copy
}

/** 统一处理 4xx/5xx：429/5xx 转为可重试的 transport 错误并挂 Retry-After */
function raiseForStatus(status: number, body: Uint8Array, headers: Record<string, string>, stage: string): void {
  const snippet = bodyText(body)
  if (status === 429 || status >= 500) {
    const err: HttpTransportError = classifyHttpFailure(status, describeBody(body), { stage, bodySnippet: snippet }) as HttpTransportError
    err.retryAfter = headers['retry-after'] ?? null
    throw err
  }
  if (!(status >= 200 && status < 300)) {
    throw classifyHttpFailure(status, describeBody(body), { stage, bodySnippet: snippet })
  }
}

/** 把外部 signal 与超时合并为一个 AbortController；返回清理函数 */
function withTimeout(spec: HttpRequestSpec): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (spec.signal) {
    if (spec.signal.aborted) controller.abort()
    else spec.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1, spec.timeoutMs))
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
    },
  }
}

// ---------------------------------------------------------------- fetch 实现（Node / 兜底）

export const fetchTransport: HttpTransport = {
  kind: 'fetch',
  async request(spec: HttpRequestSpec): Promise<HttpResponseLike> {
    const { signal, cleanup } = withTimeout(spec)
    blog('debug', 'http', 'request', { kind: 'fetch', method: spec.method, url: maskUrl(spec.url), timeoutMs: spec.timeoutMs, headerNames: headerNames(spec.headers) })
    try {
      const resp = await fetch(spec.url, {
        method: spec.method,
        headers: spec.headers,
        body: toBody(spec.body),
        signal,
      })
      const body = new Uint8Array(await resp.arrayBuffer())
      const headers = toHeaders(resp.headers)
      raiseForStatus(resp.status, body, headers, spec.url)
      blog('debug', 'http', 'response', { kind: 'fetch', url: maskUrl(spec.url), status: resp.status })
      return makeResponse(resp.status, resp.headers, body)
    } catch (err) {
      if (!isBmuError(err)) {
        blog('error', 'http', 'error', { kind: 'fetch', url: maskUrl(spec.url), message: err instanceof Error ? err.message : String(err) })
        throw classifyNetworkFailure(err, { stage: spec.url })
      }
      const be = err as BmuError
      blog('error', 'http', 'error', {
        kind: 'fetch',
        url: maskUrl(spec.url),
        httpStatus: be.httpStatus ?? null,
        code: be.code ?? null,
        message: be.message,
        bodySnippet: be.bodySnippet || null,
      })
      throw err
    } finally {
      cleanup()
    }
  },
}/**
 * 硬超时竞速：@tauri-apps/plugin-http@2 的 dist 完全不读取 AbortSignal（已确认无 signal/abort 处理），
 * 故 withTimeout 的 controller.abort() 对其无效——一个永不 resolve 的请求会让 runJob/drain 永久卡死，
 * 表现为「全部开始」后文件卡在 pending/等待中、再点无效。这里用 Promise.race 在超时后主动 reject，
 * 使网络挂死能真正失败（进入 withRetry → 最终 failed 可见），不会冻结队列。
 * 故意比 withTimeout 的 abort 早 50ms 触发，保证超时语义优先于可能被触发的 AbortError。
 */
function raceWithTimeout<T>(p: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      blog('error', 'http', 'hardTimeout', { stage, timeoutMs })
      reject(classifyNetworkFailure(new Error('请求超时（硬超时）'), { stage }))
    }, Math.max(1, timeoutMs - 50))
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// ---------------------------------------------------------------- plugin-http 实现（Tauri 内）

/**
 * D-91：移除 plugin-http 自动注入的 Origin 头。
 *
 * tauri-plugin-http@2 在 Rust 侧无条件追加 `Origin: tauri://localhost`（commands.rs:350-361），
 * 而 mineru.net 走 istio-envoy + CORS 过滤器：任何非同源 Origin 都会被 **403 Invalid CORS request** 拒绝，
 * 请求因此到不了鉴权层——现象即「Token 明明正确却 403」，与 token 有效期/权限无关。
 * 该插件在 `unsafe-headers` 特性下支持「传空串即显式移除 Origin」（commands.rs:363-369），
 * 故此处统一注入 `Origin: ''`（Cargo.toml 已启用该特性）。
 * 说明：桌面端无跨站上下文，Origin 对服务端无业务意义；移除后行为与 curl / 原生 reqwest 一致。
 */
function withOriginRemoved(headers: Record<string, string> | undefined): Record<string, string> {
  return { ...(headers ?? {}), Origin: '' }
}

export const pluginHttpTransport: HttpTransport = {
  kind: 'plugin-http',
  async request(spec: HttpRequestSpec): Promise<HttpResponseLike> {
    const { fetch: pluginFetch } = await import('@tauri-apps/plugin-http')
    const { signal, cleanup } = withTimeout(spec)
    blog('debug', 'http', 'request', { kind: 'plugin-http', method: spec.method, url: maskUrl(spec.url), timeoutMs: spec.timeoutMs, headerNames: headerNames({ ...(spec.headers ?? {}), Origin: '' }) })
    try {
      // plugin-http 不响应 AbortSignal，必须用 raceWithTimeout 兜底（见上）
      const resp = await raceWithTimeout(
        pluginFetch(spec.url, {
          method: spec.method,
          headers: withOriginRemoved(spec.headers),
          body: toBody(spec.body),
          signal,
        }),
        spec.timeoutMs,
        spec.url,
      )
      const body = new Uint8Array(await resp.arrayBuffer())
      const headers = toHeaders(resp.headers)
      raiseForStatus(resp.status, body, headers, spec.url)
      blog('debug', 'http', 'response', { kind: 'plugin-http', url: maskUrl(spec.url), status: resp.status })
      return makeResponse(resp.status, resp.headers, body)
    } catch (err) {
      if (!isBmuError(err)) {
        blog('error', 'http', 'error', { kind: 'plugin-http', url: maskUrl(spec.url), message: err instanceof Error ? err.message : String(err) })
        throw classifyNetworkFailure(err, { stage: spec.url })
      }
      const be = err as BmuError
      blog('error', 'http', 'error', {
        kind: 'plugin-http',
        url: maskUrl(spec.url),
        httpStatus: be.httpStatus ?? null,
        code: be.code ?? null,
        message: be.message,
        bodySnippet: be.bodySnippet || null,
      })
      throw err
    } finally {
      cleanup()
    }
  },
}

/**
 * 传输选型（T1-03）：
 * - 'auto'       ：Tauri → plugin-http（CORS 规避）；Node → fetch
 * - 'fetch'      ：强制 fetch（仅 Node 无头场景有意义）
 * - 'plugin-http'：强制 plugin-http（需在 Tauri 内运行）
 */
export function createHttpTransport(kind: HttpTransportKind): HttpTransport {
  if (kind === 'fetch') return fetchTransport
  if (kind === 'plugin-http') {
    if (!isTauri()) {
      throw new BmuError('internal', 'plugin-http 传输仅可在 Tauri 环境使用；当前为 Node 环境，请用 fetch。')
    }
    return pluginHttpTransport
  }
  return isTauri() ? pluginHttpTransport : fetchTransport
}

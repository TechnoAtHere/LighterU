// MinerU Agent 轻量解析 API 客户端（免 Token，IP 限频）。
// 契约（mineru.net/doc/docs）：
//   POST {agentBase}/parse/file  { file_name, language?, enable_table?, enable_formula?, is_ocr?, page_range? }
//        → data.task_id + data.file_url（签名上传地址）
//   PUT  data.file_url（仅传字节，不设 Content-Type）
//   GET  {agentBase}/parse/{task_id} → data.state: waiting-file|uploading|pending|running|done|failed
//        done → data.markdown_url；failed → data.err_code / data.err_msg
// 限制：单文件 ≤10MB、≤20 页；仅 Markdown 输出。
// 注意：本接口**不需要** Authorization。

import { BmuError, classifyHttpFailure, isEnvelopeSuccess } from './errors'
import { log as blog } from '../platform/logger'
import type { HttpTransport } from '../platform/http'
import type { AppConfig, ParseOptions } from '../types'

const STAGE = 'agent/parse'

export interface AgentSubmitResult {
  taskId: string
  fileUrl: string
}

export interface AgentTaskStatus {
  state: string
  markdownUrl: string | null
  errCode: string | null
  errMsg: string | null
}

export interface MinerUAgentClientOptions {
  config: AppConfig
  transport: HttpTransport
  onLog?: (message: string) => void
}

function joinUrl(base: string, endpoint: string): string {
  return `${base.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
}

export class MinerUAgentClient {
  private readonly config: AppConfig
  private readonly transport: HttpTransport
  private readonly onLog: (message: string) => void

  constructor(opts: MinerUAgentClientOptions) {
    this.config = opts.config
    this.transport = opts.transport
    this.onLog = opts.onLog ?? (() => undefined)
  }

  private base(): string {
    return (this.config.mineru.agentBaseUrl || 'https://mineru.net/api/v1/agent').replace(/\/+$/, '')
  }

  private async apiJson(
    method: 'GET' | 'POST',
    endpoint: string,
    payload: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const url = joinUrl(this.base(), endpoint)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (payload !== undefined) headers['Content-Type'] = 'application/json'
    blog('debug', 'mineru-agent', 'request', { method, endpoint })
    const resp = await this.transport.request({
      url,
      method,
      headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      timeoutMs: this.config.mineru.requestTimeoutMs,
      signal,
    })
    let parsed: unknown
    try {
      parsed = resp.json<unknown>()
    } catch {
      parsed = undefined
    }
    const p = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    if (resp.status >= 400 || p.success === false || (parsed !== undefined && !isEnvelopeSuccess(p))) {
      blog('warn', 'mineru-agent', 'fail', { endpoint, status: resp.status, code: p.code ?? null, msg: p.msg ?? null })
      throw classifyHttpFailure(resp.status, p, { stage: STAGE })
    }
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
      throw new BmuError('business', `Agent 接口返回无效 JSON（HTTP ${resp.status}）。`, { code: 'INVALID_JSON', stage: STAGE })
    }
    return p
  }

  /** 提交本地文件解析任务，返回 task_id 与签名上传地址 */
  async submitFile(fileName: string, parse: ParseOptions, signal?: AbortSignal): Promise<AgentSubmitResult> {
    const payload: Record<string, unknown> = { file_name: fileName }
    if (parse.language) payload.language = parse.language
    payload.is_ocr = parse.isOcr
    payload.enable_table = parse.enableTable
    payload.enable_formula = parse.enableFormula
    // Agent 仅支持单段页码范围（如 1-20）；多段逗号形态不传，交给服务端默认
    const range = (parse.pageRanges ?? '').trim()
    if (range && !range.includes(',')) payload.page_range = range

    const body = await this.apiJson('POST', '/parse/file', payload, signal)
    const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : {}
    const taskId = typeof data.task_id === 'string' ? data.task_id : ''
    const fileUrl = typeof data.file_url === 'string' ? data.file_url : ''
    if (!taskId || !fileUrl) {
      throw new BmuError('business', 'Agent 提交响应缺少 task_id 或 file_url。', { code: 'BAD_AGENT_SUBMIT', stage: STAGE })
    }
    blog('debug', 'mineru-agent', 'submit.ok', { taskId })
    this.onLog(`Agent 任务已提交（${taskId}）`)
    return { taskId, fileUrl }
  }

  /** 上传文件字节到签名地址（不设 Content-Type，避免 OSS 签名校验失败） */
  async upload(fileUrl: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.transport.request({
      url: fileUrl,
      method: 'PUT',
      body: bytes,
      timeoutMs: Math.max(this.config.mineru.requestTimeoutMs, 120_000),
      signal,
    })
    blog('debug', 'mineru-agent', 'upload.done', { kb: Math.round(bytes.length / 1024) })
  }

  /** 查询任务状态 */
  async getStatus(taskId: string, signal?: AbortSignal): Promise<AgentTaskStatus> {
    const body = await this.apiJson('GET', `/parse/${encodeURIComponent(taskId)}`, undefined, signal)
    const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : {}
    const state = typeof data.state === 'string' ? data.state : ''
    const markdownUrl = typeof data.markdown_url === 'string' ? data.markdown_url : null
    const errCodeRaw = data.err_code
    const errCode = errCodeRaw === undefined || errCodeRaw === null ? null : String(errCodeRaw)
    const errMsg = typeof data.err_msg === 'string' ? data.err_msg : null
    return { state, markdownUrl, errCode, errMsg }
  }

  /** 轮询到终态（done / failed） */
  async waitForTask(
    taskId: string,
    opts: { signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number; onStatus?: (s: AgentTaskStatus) => void } = {},
  ): Promise<AgentTaskStatus> {
    const timeoutMs = opts.timeoutMs ?? this.config.mineru.taskTimeoutMs
    const pollIntervalMs = opts.pollIntervalMs ?? this.config.mineru.pollIntervalMs
    const startedAt = Date.now()
    for (;;) {
      if (opts.signal?.aborted) throw new BmuError('canceled', '任务已取消。', { stage: 'agent/polling' })
      const status = await this.getStatus(taskId, opts.signal)
      opts.onStatus?.(status)
      if (status.state === 'done') {
        if (!status.markdownUrl) {
          throw new BmuError('business', 'Agent 解析完成但未返回 markdown_url。', { code: 'NO_MARKDOWN_URL', stage: STAGE })
        }
        return status
      }
      if (status.state === 'failed') {
        const detail = status.errMsg || status.errCode || '未知原因'
        throw new BmuError('business', `Agent 轻量解析失败：${detail}`, {
          code: status.errCode ?? 'AGENT_PARSE_FAILED',
          stage: STAGE,
        })
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new BmuError('business', `等待 Agent 轻量解析超时（task ${taskId}）。`, { code: 'POLL_TIMEOUT', stage: STAGE })
      }
      // 注意：正常 resolve 时必须移除 abort 监听，否则长轮询会累积监听器（泄漏）
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>
        const onAbort = (): void => {
          clearTimeout(timer)
          reject(new BmuError('canceled', '任务已取消。', { stage: 'agent/polling' }))
        }
        timer = setTimeout(() => {
          opts.signal?.removeEventListener('abort', onAbort)
          resolve()
        }, pollIntervalMs)
        opts.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  /** 下载 Markdown（CDN 链接，无鉴权） */
  async downloadMarkdown(markdownUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
    const resp = await this.transport.request({
      url: markdownUrl,
      method: 'GET',
      timeoutMs: Math.max(this.config.mineru.requestTimeoutMs, 120_000),
      signal,
    })
    // 防异常大响应：Markdown 结果上限 20MB
    const max = 20 * 1024 * 1024
    if (resp.body.length > max) {
      throw new BmuError('limit', `Agent 返回的 Markdown 过大（${(resp.body.length / 1024 / 1024).toFixed(1)}MB，上限 20MB）。`, {
        code: 'AGENT_MARKDOWN_TOO_LARGE',
        stage: STAGE,
      })
    }
    return resp.body
  }
}

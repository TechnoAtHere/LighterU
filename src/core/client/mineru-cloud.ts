// M02 · core/client/mineru-cloud — mineru.net 云端 v4 客户端（T1-06/T1-07/T1-08/T1-09/T1-10）
// 契约依据 plan/04 P-2（端点清单 / Bearer 认证 / 错误码表）与 OT-X 实证：
//   1. POST /api/v4/file-urls/batch（Bearer）→ {code:0, data:{batch_id, file_urls[]}}
//   2. PUT 预签名 URL（无 Authorization、无 Content-Type；上传完成自动提交解析）
//   3. GET  /api/v4/extract-results/batch/{batch_id}（Bearer）→ data.extract_result[0]
//   4. GET  full_zip_url（跨域 OSS，无 token）；done 即下载，404 按 task_id 重查一次（D-27）
// MIT License — 改编自 MinerU-OCR-Tool（src/mineru_ocr_tool/client.py:212-434 MinerUCloudClient，
// 许可证经 D-29 用户确认为 MIT；保留原始版权声明与 LICENSE；逻辑按 D-07 以 TypeScript 重写。

import { BmuError, classifyHttpFailure, isBmuError, isEnvelopeSuccess } from './errors'
import { defaultShouldRetry, sleep, withRetry } from './retry'
import { parseTaskStatus } from './compat'
import type { HttpTransport, HttpTransportError, HttpResponseLike } from '../platform/http'
import type { AppConfig, FileUrlsRequest, FileUrlsResult, TaskStatus } from '../types'
import { log as blog, maskUrl } from '../platform/logger'

export interface MinerUCloudClientOptions {
  config: AppConfig
  transport: HttpTransport
  onLog?: (message: string) => void
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
}

export class MinerUCloudClient {
  private readonly config: AppConfig
  private readonly transport: HttpTransport
  private readonly onLog: (message: string) => void

  constructor(opts: MinerUCloudClientOptions) {
    this.config = opts.config
    this.transport = opts.transport
    this.onLog = opts.onLog ?? (() => undefined)
  }

  // ------------------------------------------------------------ 1. 申请上传 URL

  /** POST /api/v4/file-urls/batch → (batch_id, upload_url)（OT-X request_upload_url 实证字段） */
  async requestUploadUrl(req: FileUrlsRequest, signal?: AbortSignal): Promise<FileUrlsResult> {
    const parse = req.parse
    const payload: Record<string, unknown> = {
      files: [{ name: req.fileName, is_ocr: parse.isOcr }],
      model_version: parse.modelVersion,
      language: parse.language,
      enable_formula: parse.enableFormula,
      enable_table: parse.enableTable,
    }
    if (parse.pageRanges.trim()) payload.page_ranges = parse.pageRanges.trim()
    if (parse.extraFormats.length > 0) payload.extra_formats = [...parse.extraFormats]

    blog('debug', 'mineru', 'uploadUrl.request', { file: req.fileName, isOcr: parse.isOcr })
    const body = await this.apiJson('POST', '/file-urls/batch', payload, signal, 'file-urls/batch')
    const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : null
    const batchId = data && typeof data.batch_id !== 'undefined' ? String(data.batch_id) : ''
    const urls = data?.file_urls
    if (!batchId || !Array.isArray(urls) || urls.length < 1) {
      throw new BmuError('business', '申请上传地址的响应缺少 batch_id 或 file_urls。', { code: 'BAD_UPLOAD_URLS', stage: 'file-urls/batch' })
    }
    blog('debug', 'mineru', 'uploadUrl.ok', { batchId })
    return { batchId, uploadUrl: String(urls[0]) }
  }

  // ------------------------------------------------------------ 2. PUT 上传（无鉴权）

  /** PUT 原始字节到预签名 URL：无 Authorization、无 Content-Type（OT-X 实证）；429/5xx 退避重试 */
  async uploadFile(uploadUrl: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const { maxAttempts, requestTimeoutMs } = this.config.mineru
    blog('debug', 'mineru', 'upload.start', { url: maskUrl(uploadUrl), kb: Math.round(data.length / 1024) })
    await withRetry(
      async () => {
        await this.transport.request({
          url: uploadUrl,
          method: 'PUT',
          body: data,
          timeoutMs: requestTimeoutMs,
          signal,
        })
      },
      {
        maxAttempts,
        stage: 'upload',
        signal,
        shouldRetry: defaultShouldRetry,
        retryAfterOf: (err) => (err as HttpTransportError).retryAfter ?? null,
        onRetry: (attempt, delay) => this.onLog(`上传重试 ${attempt}（${delay.toFixed(1)}s 后）`),
      },
    )
    blog('debug', 'mineru', 'upload.done')
  }

  // ------------------------------------------------------------ 3. 批量/单任务查询

  /** GET /api/v4/extract-results/batch/{batch_id} → 单项 TaskStatus */
  async getBatchStatus(batchId: string, signal?: AbortSignal): Promise<TaskStatus> {
    const body = await this.apiJson(
      'GET',
      `/extract-results/batch/${encodeURIComponent(batchId)}`,
      undefined,
      signal,
      'extract-results/batch',
    )
    const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : null
    const results = data?.extract_result
    if (!Array.isArray(results) || results.length === 0 || typeof results[0] !== 'object' || results[0] === null) {
      throw new BmuError('business', '批次状态响应缺少 extract_result。', { code: 'BAD_BATCH_STATUS', stage: 'extract-results/batch' })
    }
    // 传入单项而非整个信封（OT-X 实证：信封顶层 msg 会遮蔽单项 err_msg）
    return this.parseStatus(batchId, batchId, results[0] as Record<string, unknown>)
  }

  /** GET /api/v4/extract/task/{task_id}（D-27 重查路径；兼容 data 直返与 extract_result 包裹两种形态） */
  async getTaskStatus(taskId: string, signal?: AbortSignal): Promise<TaskStatus> {
    const body = await this.apiJson(
      'GET',
      `/extract/task/${encodeURIComponent(taskId)}`,
      undefined,
      signal,
      'extract/task',
    )
    const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : null
    if (data && Array.isArray(data.extract_result) && data.extract_result.length > 0) {
      return this.parseStatus(taskId, taskId, data.extract_result[0] as Record<string, unknown>)
    }
    if (data) return this.parseStatus(taskId, taskId, data)
    return this.parseStatus(taskId, taskId, body)
  }

  /** 轮询到终态（T1-15 取消检查点之一：每轮检查 signal） */
  async waitForCompletion(
    batchId: string,
    opts: {
      signal?: AbortSignal
      onProgress?: (status: TaskStatus) => void
      timeoutMs?: number
      pollIntervalMs?: number
    } = {},
  ): Promise<TaskStatus> {
    const timeoutMs = opts.timeoutMs ?? this.config.mineru.taskTimeoutMs
    const pollIntervalMs = opts.pollIntervalMs ?? this.config.mineru.pollIntervalMs
    const startedAt = Date.now()
    blog('debug', 'mineru', 'poll.start', { batchId, timeoutMs, pollIntervalMs })
    for (;;) {
      if (opts.signal?.aborted) throw new BmuError('canceled', '任务已取消。', { stage: 'polling' })
      const status = await this.getBatchStatus(batchId, opts.signal)
      opts.onProgress?.(status)
      if (status.state === 'done') {
        blog('debug', 'mineru', 'poll.done', { batchId, pages: status.totalPages ?? null })
        return status
      }
      if (status.state === 'failed') {
        blog('warn', 'mineru', 'poll.failed', { batchId, message: status.message })
        throw new BmuError('business', `MinerU 云端解析失败：${status.message || '未知原因'}`, {
          code: 'PARSE_FAILED', stage: 'polling',
        })
      }
      if (Date.now() - startedAt > timeoutMs) {
        blog('error', 'mineru', 'poll.timeout', { batchId, timeoutMs })
        throw new BmuError('business', `等待 mineru.net 解析超时（batch ${batchId}，${Math.round(timeoutMs / 1000)}s）。`, {
          code: 'POLL_TIMEOUT', stage: 'polling',
        })
      }
      await sleep(pollIntervalMs, opts.signal)
    }
  }

  // ------------------------------------------------------------ 4. 下载结果（无鉴权）

  /** GET full_zip_url（OSS，无 token；T1-15 取消检查点：fetch 直接中断） */
  async downloadResult(status: TaskStatus, signal?: AbortSignal): Promise<Uint8Array> {
    const url = status.resultUrl
    if (!url) {
      throw new BmuError('business', 'MinerU 云端未返回结果下载地址（full_zip_url）。', { code: 'NO_RESULT_URL', stage: 'downloading' })
    }
    blog('debug', 'mineru', 'download.start', { url: maskUrl(url) })
    const resp = await this.transport.request({
      url,
      method: 'GET',
      timeoutMs: this.config.mineru.requestTimeoutMs,
      signal,
    })
    blog('debug', 'mineru', 'download.done', { kb: Math.round(resp.body.length / 1024) })
    return resp.body
  }

  /**
   * done 即下载；404 → 按 task_id 重查一次再下（D-27）。
   * 判定条件：错误码为 HTTP_404，或 4xx 业务码为 -60012（任务/结果不存在）——
   * OSS 裸 404 与 API「任务不存在」都应触发重查容错。
   * requery 由调用方提供（通常为 () => getTaskStatus(taskId)）。
   */
  async downloadResultWithFallback(
    status: TaskStatus,
    requery: () => Promise<TaskStatus>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      return await this.downloadResult(status, signal)
    } catch (err) {
      if (isBmuError(err) && (err.code === 'HTTP_404' || err.code === '-60012')) {
        this.onLog('结果下载 404，按 task_id 重查一次后再下（D-27）。')
        const fresh = await requery()
        if (fresh.resultUrl) return await this.downloadResult(fresh, signal)
      }
      throw err
    }
  }

  // ------------------------------------------------------------ 5. 额度查询（T5-09，尽力做）

  /**
   * T5-09：查询账户额度（本月已用页数 / 总额度）。
   * 现状：MinerU 官方 /api/v4 无公开额度端点（已查 OT client.py 与 mineru-tianshu，均无 usage/quota 参考），
   * 按任务约定「端点不可用则降级」——返回 null，设置页据此隐藏额度字段，不凭猜写端点。
   * 若后续端点文档化，在此实现（Bearer 认证 + 归一 {used,total}）。
   */
  async getUsage(): Promise<{ used: number; total: number } | null> {
    return null
  }

  // ------------------------------------------------------------ 内部：JSON 传输 + 重试 + 分类
  private parseStatus(taskId: string, batchId: string, payload: Record<string, unknown>): TaskStatus {
    return parseTaskStatus(taskId, batchId, payload)
  }

  /**
   * 统一 JSON 请求：Bearer 认证、退避重试（429/5xx/网络）、错误分类（T1-05/T1-09）。
   * 4xx/业务码不重试；A0202/A0211 归认证错误（T1-09）。
   */
  private async apiJson(
    method: 'GET' | 'POST',
    endpoint: string,
    payload: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    stage: string,
  ): Promise<Record<string, unknown>> {
    const { baseUrl, token, maxAttempts, requestTimeoutMs } = this.config.mineru
    if (!token) {
      blog('warn', 'mineru', 'api.noToken', { endpoint })
      throw new BmuError('auth', '未配置 MinerU Token——请到 mineru.net「API 管理」页创建后填入设置。', {
        code: 'NO_TOKEN', stage, retryable: false,
      })
    }
    blog('debug', 'mineru', 'api.request', { method, endpoint })
    const url = joinUrl(baseUrl, endpoint)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    if (payload !== undefined) headers['Content-Type'] = 'application/json'

    return withRetry(
      async () => {
        let resp: HttpResponseLike
        try {
          resp = await this.transport.request({
            url,
            method,
            headers,
            body: payload !== undefined ? JSON.stringify(payload) : undefined,
            timeoutMs: requestTimeoutMs,
            signal,
          })
        } catch (err) {
          // D-93：传输层在解析响应体前即对 4xx/5xx 抛出（raiseForStatus），
          // 使下方 api.fail 对非 2xx 成为死分支——本次「403 无任何线索」即由此导致。
          // 这里补记一次，保证「HTTP 状态 + 业务码 + 服务端正文」三者齐全。
          if (isBmuError(err)) {
            blog('warn', 'mineru', 'api.fail', {
              endpoint,
              httpStatus: err.httpStatus ?? null,
              code: err.code ?? null,
              msg: err.message,
              bodySnippet: err.bodySnippet || null,
            })
          }
          throw err
        }
        let parsed: unknown
        try {
          parsed = resp.json<unknown>()
        } catch {
          parsed = undefined
        }
        if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
          throw new BmuError('business', `mineru.net 返回无效 JSON（HTTP ${resp.status}，${endpoint}）。`, {
            code: 'INVALID_JSON', stage,
          })
        }
        const p = parsed as Record<string, unknown>
        if (p.success === false || !isEnvelopeSuccess(p)) {
          // 诊断：把 HTTP 状态 + 服务端错误码/消息写入日志（不含 token），便于定位 403 等鉴权失败。
          blog('warn', 'mineru', 'api.fail', {
            endpoint,
            httpStatus: resp.status,
            code: p.code ?? null,
            msg: p.msg ?? p.message ?? null,
          })
          throw classifyHttpFailure(resp.status, p, { stage })
        }
        blog('debug', 'mineru', 'api.ok', { endpoint, status: resp.status })
        return p
      },
      {
        maxAttempts,
        stage,
        signal,
        shouldRetry: defaultShouldRetry,
        retryAfterOf: (err) => (err as HttpTransportError).retryAfter ?? null,
        onRetry: (attempt, delay, err) => this.onLog(`${endpoint} 重试 ${attempt}/${maxAttempts}（${err.kind}，${delay.toFixed(1)}s 后）`),
      },
    )
  }
}

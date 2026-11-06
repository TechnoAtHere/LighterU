// core/client/models — 拉取 OpenAI 兼容端点的可用模型列表（D-95）
// 用途：设置页「图片描述」填写 API 地址后，自动请求 {baseUrl}/models 作为模型下拉备选。
// 契约：GET {baseUrl}/models，Bearer 认证，返回体兼容三种形态（OpenAI data[].id / 裸数组 / models[]）。
// 注意：并非所有厂商都实现该端点（如部分国产平台的 /v1 仅为 chat 兼容），失败必须可降级为手填。

import { BmuError, classifyNetworkFailure, isBmuError } from './errors'
import type { HttpTransport } from '../platform/http'
import { log as blog, maskUrl } from '../platform/logger'

/** 模型列表请求超时：探测性质，快速失败优于久等 */
export const MODELS_TIMEOUT_MS = 12_000

/**
 * 解析模型列表响应（容错）：
 *   1. OpenAI：{ data: [{ id }] }
 *   2. 裸数组：["a","b"] 或 [{ id }]
 *   3. 其他：{ models: [{ id | name | model }] }
 * 非 JSON（如 WAF 拦截页）返回空数组，由调用方提示手填。
 */
export function parseModels(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  const push = (v: unknown): void => {
    let id = ''
    if (typeof v === 'string') id = v
    else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      const raw = o.id ?? o.model ?? o.name
      if (typeof raw === 'string') id = raw
    }
    id = id.trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  if (Array.isArray(parsed)) {
    parsed.forEach(push)
  } else if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    const arr = o.data ?? o.models
    if (Array.isArray(arr)) arr.forEach(push)
  }
  return out
}

export interface ListModelsOptions {
  transport: HttpTransport
  baseUrl: string
  apiKey: string
  timeoutMs?: number
}

/**
 * 请求 {baseUrl}/models 并返回模型 id 列表（保持服务端顺序）。
 * 失败时抛出带用户可读消息的 BmuError；调用方据此提示「可手动填写」。
 */
export async function listModels(opts: ListModelsOptions): Promise<string[]> {
  const base = (opts.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) {
    throw new BmuError('business', '未配置 API 地址——请先填写 OpenAI 兼容端点。', { code: 'NO_BASE_URL' })
  }
  const key = (opts.apiKey ?? '').trim()
  if (!key) {
    throw new BmuError('auth', '未配置 API Key——填入密钥后才能获取模型列表。', { code: 'NO_API_KEY' })
  }
  const url = `${base}/models`
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${key}` }
  let body: Uint8Array
  try {
    const resp = await opts.transport.request({
      url,
      method: 'GET',
      headers,
      timeoutMs: opts.timeoutMs ?? MODELS_TIMEOUT_MS,
    })
    body = resp.body
  } catch (err) {
    if (isBmuError(err)) {
      // 404/405：该厂商未实现模型列表端点 → 明确告知可手填，而非笼统「失败」
      if (err.httpStatus === 404 || err.httpStatus === 405) {
        blog('warn', 'multimodal', 'models.unsupported', { url: maskUrl(url), httpStatus: err.httpStatus })
        throw new BmuError('business', '该服务商未提供模型列表接口，请手动填写模型名。', {
          code: 'MODELS_UNSUPPORTED', httpStatus: err.httpStatus, bodySnippet: err.bodySnippet,
        })
      }
      // 认证失败：改写为多模态语境（原生消息面向 MinerU Token，易误导）
      if (err.kind === 'auth') {
        blog('warn', 'multimodal', 'models.fail', { url: maskUrl(url), httpStatus: err.httpStatus ?? null, code: err.code ?? null })
        throw new BmuError('auth', 'API Key 无效或权限不足，无法获取模型列表，请检查密钥。', {
          code: err.code, httpStatus: err.httpStatus, bodySnippet: err.bodySnippet,
        })
      }
      blog('warn', 'multimodal', 'models.fail', {
        url: maskUrl(url), httpStatus: err.httpStatus ?? null, code: err.code ?? null, msg: err.message,
      })
      throw err
    }
    blog('error', 'multimodal', 'models.error', { url: maskUrl(url), message: err instanceof Error ? err.message : String(err) })
    throw classifyNetworkFailure(err, { stage: 'models' })
  }
  const ids = parseModels(new TextDecoder('utf-8').decode(body))
  blog('info', 'multimodal', 'models.ok', { url: maskUrl(url), count: ids.length })
  return ids
}

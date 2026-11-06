// M10 · core/preflight — 连通性检查（T2-11）
// 契约参照 TS-X007（天枢 test_connection 三元组 {ok, msg, latency}）与 OT-G196（vlm_preflight.py）。
// 语义：**网络层可达即 ok**——服务端有响应（含 401/403/404/429/5xx）都说明端点可达，
// 认证/模型问题是另外一回事（msg 中说明）；仅网络不可达/超时判 false。
// 不做重试（探测是一次性快照；重试属 T2-04 描述调用链路）。

import type { AppConfig } from '../types'
import { isBmuError } from '../client/errors'
import type { HttpTransport } from '../platform/http'

/** 探测超时（毫秒）：探测应快速失败，不占用用户等待 */
export const PREFLIGHT_TIMEOUT_MS = 10_000

export interface TestConnectionResult {
  ok: boolean
  msg: string
  latency: number
}

interface PreflightPlan {
  url: string
  headers: Record<string, string>
  /** 200 响应体的附加解析（如多模态模型列表） */
  onOk?: (body: Uint8Array, status: number) => string
}

function planFor(kind: 'mineru' | 'multimodal', config: AppConfig): PreflightPlan | null {
  if (kind === 'mineru') {
    const base = config.mineru.baseUrl.trim()
    if (!base) return null
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (config.mineru.token) headers.Authorization = `Bearer ${config.mineru.token}`
    // 任意只读路径均可判定可达性：无 token → 401；有 token → 业务信封（均证明网络通）
    return { url: `${base.replace(/\/+$/, '')}/extract-results/batch/_preflight`, headers }
  }
  const base = config.multimodal.baseUrl.trim()
  if (!base) return null
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.multimodal.apiKey) headers.Authorization = `Bearer ${config.multimodal.apiKey}`
  return {
    url: `${base.replace(/\/+$/, '')}/models`,
    headers,
    onOk: (body) => {
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8').decode(body)) as { data?: Array<{ id?: string }> }
        const ids = Array.isArray(parsed.data) ? parsed.data.map((m) => String(m?.id ?? '')).filter(Boolean) : []
        if (ids.length === 0) return '连接成功（HTTP 200）'
        if (config.multimodal.model && ids.includes(config.multimodal.model)) {
          return `连接成功，模型 ${config.multimodal.model} 可用（共 ${ids.length} 个）`
        }
        return `连接成功，但模型列表中未找到 ${config.multimodal.model || '（未配置模型）'}（可用 ${ids.slice(0, 5).join(', ')}…）`
      } catch {
        return '连接成功（HTTP 200）'
      }
    },
  }
}

/**
 * 端点连通性检查（T2-11）。
 * - 未配置 base_url → `{ok:false, msg:'未配置端点'}`
 * - 2xx → ok；401/403（auth 类）或任何带 HTTP_ 码的响应 → ok（可达，问题在认证/路径）
 * - 超时（AbortError→canceled）→ `{ok:false, msg:'超时'}`；网络错误 → ok:false
 */
export async function testConnection(
  kind: 'mineru' | 'multimodal',
  transport: HttpTransport,
  config: AppConfig,
  opts: { timeoutMs?: number } = {},
): Promise<TestConnectionResult> {
  const plan = planFor(kind, config)
  if (plan === null) return { ok: false, msg: '未配置端点', latency: 0 }

  const startedAt = Date.now()
  try {
    const resp = await transport.request({
      url: plan.url,
      method: 'GET',
      headers: plan.headers,
      timeoutMs: opts.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
    })
    const latency = Date.now() - startedAt
    return { ok: true, msg: plan.onOk ? plan.onOk(resp.body, resp.status) : `连接成功（HTTP ${resp.status}）`, latency }
  } catch (err) {
    const latency = Date.now() - startedAt
    if (isBmuError(err)) {
      if (err.kind === 'canceled') return { ok: false, msg: '超时', latency }
      // 服务端有响应即可达：auth 类（A0202/HTTP_401/403）或任何 HTTP_ 业务码
      if (err.kind === 'auth' || (typeof err.code === 'string' && err.code.startsWith('HTTP_'))) {
        return { ok: true, msg: `端点可达（${err.code ?? 'HTTP 401'}，认证或路径问题见消息）`, latency }
      }
      return { ok: false, msg: `网络错误：${err.message}`, latency }
    }
    return { ok: false, msg: `内部错误：${String(err)}`, latency }
  }
}

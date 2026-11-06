// 图片描述（多模态 / LLM）服务商预设：OpenAI 兼容协议。
// 只提供「默认地址 + 默认模型」便捷填充；用户仍可手填任意 OpenAI 兼容端点（自定义）。
//
// 取值依据（2026-11 官方文档实证，D-95）：
//   · DeepSeek  base_url = https://api.deepseek.com（路径直接 /chat/completions，不带 /v1）
//              视觉模型 = deepseek-flash（DeepSeek-V4.1-Flash，原生接受图片）
//   · Kimi      base_url = https://api.moonshot.cn/v1（platform.kimi.com 文档示例）
//              视觉模型 = kimi-k3.1-pro（原生视觉理解；K3 / K2.7 Code / K2.6 亦支持图片）
//   · MiniMax   base_url = https://api.minimax.cn/v1（OpenAI 兼容端点）
//              视觉模型 = MiniMax-M3.1-Flash（M3 系列原生多模态，支持图像输入）
// 说明：OpenAI 预设已按用户要求移除（D-95）。base_url 是否带 /v1 由各厂商定义，客户端统一拼接 /chat/completions。

export type LlmProviderId = 'deepseek' | 'kimi' | 'minimax'

export interface LlmProviderPreset {
  id: LlmProviderId
  name: string
  /** OpenAI 兼容根地址（不含 /chat/completions；是否带 /v1 由各厂商定义） */
  baseUrl: string
  /** 默认模型（可手改） */
  model: string
  /** 是否支持图片输入 */
  supportsVision: boolean
  /** 选中后展示的提示（如能力限制） */
  note?: string
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    supportsVision: true,
    note: 'deepseek-flash 原生支持图片输入（JPEG/PNG/GIF/WebP）。',
  },
  {
    id: 'kimi',
    name: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3.1-pro',
    supportsVision: true,
    note: 'Kimi K3.1 Pro / K3 / K2.7 Code / K2.6 支持文本、图片与视频输入。',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.cn/v1',
    model: 'MiniMax-M3.1-Flash',
    supportsVision: true,
    note: 'MiniMax M3 系列原生多模态，支持图像输入；模型名区分大小写。',
  },
]

/** 按 baseUrl 反查预设（用于下拉回显）；未命中返回 null（视为自定义） */
export function matchProvider(baseUrl: string): LlmProviderPreset | null {
  const norm = (baseUrl ?? '').trim().replace(/\/+$/, '')
  // 兼容「带 /v1 与不带 /v1」两种写法指向同一服务商（如 DeepSeek 两种均可用）
  const stripV1 = (s: string): string => s.replace(/\/v1$/, '')
  const hit = LLM_PROVIDER_PRESETS.find((p) => p.baseUrl === norm)
  if (hit) return hit
  return LLM_PROVIDER_PRESETS.find((p) => stripV1(p.baseUrl) === stripV1(norm)) ?? null
}

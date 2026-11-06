// M02 · core/client/logmask — 日志/错误信息密钥脱敏（T2-14）
// 需求 §八：Token 和 Key 加密存储、不明文落盘；日志通道同样不得出现明文。
// 应用点：多模态客户端错误 remap（供应商错误文案可能回显 Key）；
//         后续 App.vue/诊断日志展示 token 时同样经此模块（F-17 延伸）。

/**
 * 遮蔽密钥（T2-14 验收口径）：
 * - 长度 ≤ 8：整体替换为 `****`（短值保留片段也无意义）
 * - 长度 > 8：保留前 3 + `****` + 后 3（如 `sk-1234567890` → `sk-****890`）
 */
export function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '****'
  return `${value.slice(0, 3)}****${value.slice(-3)}`
}

/**
 * 文本中出现的已知密钥值全部替换为掩码（按值精确匹配，不误伤非密钥文本）。
 * 长度 < 8 的密钥跳过替换（过短值在文本中误伤面大，且 maskSecret 对其整体打星已无信息量）。
 */
export function maskSecretsInText(text: string, secrets: Array<string | undefined | null>): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    if (!out.includes(secret)) continue
    out = out.split(secret).join(maskSecret(secret))
  }
  return out
}

/**
 * 防御式脱敏（T4-08 事件 payload 用）：按形态识别密钥样子串并遮蔽，复用 maskSecret。
 * 不知晓明文密钥时兜底——识别 `sk-…` 与 `Bearer <token>` 两类常见形态。
 */
export function scrubSecrets(text: string): string {
  if (!text) return text
  let out = text.replace(/\b(sk-[A-Za-z0-9_-]{6,})/g, (m) => maskSecret(m))
  out = out.replace(/(Bearer\s+)([A-Za-z0-9._-]{8,})/gi, (_m, prefix: string, tok: string) => `${prefix}${maskSecret(tok)}`)
  return out
}

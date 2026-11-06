// M04 · core/caption/fingerprint — 内容指纹（T2-06）
// 参照 VS-X025（Visuals-Skill image_to_text.py:50-52 `_fingerprint`：md5[:8] 8 位十六进制）。
// 差异说明：VS 的指纹对象是**输出内容文本**（描述+OCR，供下游 DeepSeek 去重）；
// 本项目的用途是**图片字节指纹**（plan/02 T2-06 验收：相同图片第二次不重复发起调用），
// 故输入为图片字节而非文本。精度与 VS 同为 32 位（8  hex）——单文档内重复图（页眉/Logo 等）
// 误撞率可接受；如未来跨文档大规模去重需升级为 64 位。
// 不引 crypto 依赖：FNV-1a 32 位变体，Node/WebView 双端同步可用。

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

function toHex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

/** 图片字节 → 8 位十六进制指纹（相同字节必得相同指纹；不同字节应得不同指纹） */
export function fingerprint(data: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i]
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  // 长度参与二次混合：不同长度的同前缀内容（如前 N 字节相同的截断图）不致相撞
  let mixed = (hash ^ Math.imul(data.length, FNV_PRIME)) >>> 0
  mixed = Math.imul(mixed ^ (mixed >>> 15), FNV_PRIME) >>> 0
  return toHex8(mixed)
}

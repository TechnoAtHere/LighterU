// M05 · core/output/writeback — 图片描述两种写入方式（T2-08/T2-09，D-34/D-36）
// 需求终版 §四/§五.4：开关开启时生效——替换原文件（T2-08）/ 两者都有（T2-09）；
// 按入口分默认：右键=替换，工作站=两者都有；JSON img_caption 回写 V0.3 不做（D-34）。
// 契约参照 TS-X016/017（天枢 writebackMarkdown/Json 的位置与职责）；因需求终版改为
// 「整段替换/旁注」语义（原 alt 增强语义废止），实现按 D-34 重写。
// MIT License — 职责边界改编自 mineru-tianshu（Apache 2.0，保留版权声明）。

import { normalizeDescription } from '../caption/normalize'

/** Markdown 图片引用：`![alt](path)` 或 `![alt](path "title")`（path 不含空白与右括号） */
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

/** HTML img：`<img src="path" ...>`（src 单引号或双引号） */
const HTML_IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi

/** 旁注前缀（D-36：引用后一空格 + `[图片描述:…]`） */
const ANNOTATION_PREFIX = ' [图片描述:'

/**
 * 相对引用 → 描述查找：captions 键为统一正斜杠路径（runCaption 产出），
 * Markdown 内为相对引用（images/a.png / ./images/a.png / URL 编码空格）。
 * 匹配序：键直接命中 → 解码后后缀匹配（路径段边界，防 a.png 误配 xa.png）。
 */
function findCaption(ref: string, captions: Map<string, string>): string | undefined {
  const direct = captions.get(ref)
  if (direct !== undefined) return direct
  let decoded: string
  try {
    decoded = decodeURIComponent(ref)
  } catch {
    decoded = ref
  }
  const normRef = decoded.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normRef) return undefined
  for (const [key, value] of captions) {
    const normKey = key.replace(/\\/g, '/')
    if (normKey === normRef || normKey.endsWith(`/${normRef}`)) return value
  }
  return undefined
}

/** 引用之后是否已紧跟旁注（幂等检测，D-36） */
function hasAnnotationAfter(text: string, pos: number): boolean {
  return text.slice(pos, pos + ANNOTATION_PREFIX.length) === ANNOTATION_PREFIX
}

/**
 * T2-08 · 替换原文件：命中的图片引用整段替换为归一描述（右键入口默认）。
 * 幂等：替换后引用不复存在，重复执行结果一致。
 */
export function writebackReplace(markdown: string, captions: Map<string, string>): string {
  const afterMd = markdown.replace(MD_IMAGE_RE, (full, ref: string) => {
    const caption = findCaption(ref, captions)
    return caption ? normalizeDescription(caption) : full
  })
  return afterMd.replace(HTML_IMG_RE, (full, ref: string) => {
    const caption = findCaption(ref, captions)
    return caption ? normalizeDescription(caption) : full
  })
}

/**
 * T2-09 · 两者都有：命中则保留原引用，在其后追加 ` [图片描述:描述文本]`（D-36，一空格）；
 * 描述经归一（方括号全角化 + 长度硬顶）防破坏结构。
 * 幂等：检测引用后已有 ` [图片描述:` 则不重复追加。
 */
export function writebackBoth(markdown: string, captions: Map<string, string>): string {
  const afterMd = markdown.replace(MD_IMAGE_RE, (full, ref: string, offset: number) => {
    const caption = findCaption(ref, captions)
    if (!caption) return full
    if (hasAnnotationAfter(markdown, offset + full.length)) return full
    return `${full}${ANNOTATION_PREFIX}${normalizeDescription(caption)}]`
  })
  return afterMd.replace(HTML_IMG_RE, (full, ref: string, offset: number) => {
    const caption = findCaption(ref, captions)
    if (!caption) return full
    if (hasAnnotationAfter(afterMd, offset + full.length)) return full
    return `${full}${ANNOTATION_PREFIX}${normalizeDescription(caption)}]`
  })
}

/** 按模式分发（'replace' = T2-08；'both' = T2-09） */
export function writebackMarkdown(markdown: string, captions: Map<string, string>, mode: 'replace' | 'both'): string {
  return mode === 'both' ? writebackBoth(markdown, captions) : writebackReplace(markdown, captions)
}

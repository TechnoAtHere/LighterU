// core/splitter — >200 页 PDF 自动拆分与合并（T3-09）
// 触发：服务端返回 -60006（页数超限）后由 pipeline 调用；阈值 200 页（plan/04 P-4 / D-17）。
// PDF 操作用 pdf-lib（D-21 定案）。合并语义改编自 MinerU-OCR-Tool cloud_split.py：
//   - full.md 分片按序拼接（"\n\n" 连接，OT 口径）；
//   - 图片扁平化到 images/，跨分片同名按分片序号加前缀避免冲突（p{i}_{name}）；
//   - _content_list.json 数组拼接，page_idx 加前序分片页数偏移，img_path 同步改写；
//   - 额外格式（docx/html/latex）不合并（分片上传即不产出）。
// MIT License — 合并语义改编自 OT cloud_split.py（D-29 确认 MIT）；按 D-07 以 TS 重写。

import { firstMarkdown, pickFinalContentJson, scanOutputs } from '../output'
import type { ExtractedFile, ExtractedOutputs } from '../types'
import { log } from '../platform/logger'

/** 官方单文件页数上限（plan/04 P-4：200 页，触发 = 服务端 -60006） */
export const MAX_PAGES_PER_PART = 200

/** 1-based 闭区间页范围 */
export interface PageRange {
  start: number
  end: number
}

/** 合并入参：分片产物 + 该分片页数（用于 page_idx 偏移） */
export interface MergePart {
  outputs: ExtractedOutputs
  pageCount: number
}

/** 动态加载 pdf-lib（D-21）；仅在 -60006 拆分路径按需加载，避免进入主包 */
async function loadPdfLib(): Promise<typeof import('pdf-lib')> {
  return import('pdf-lib')
}

/**
 * 计算分片页范围（OT-X page_chunks 语义，1-based 闭区间）。
 * planParts(450, 200) → [{1,200},{201,400},{401,450}]
 * planParts(200, 200) → [{1,200}]（单分片，等同不拆）
 * planParts(0, 200)   → []（空文件，调用方处理）
 */
export function planParts(totalPages: number, maxPagesPerPart: number = MAX_PAGES_PER_PART): PageRange[] {
  if (totalPages <= 0 || maxPagesPerPart <= 0) return []
  const parts: PageRange[] = []
  for (let start = 1; start <= totalPages; start += maxPagesPerPart) {
    parts.push({ start, end: Math.min(start + maxPagesPerPart - 1, totalPages) })
  }
  return parts
}

/** 读取 PDF 总页数（只解析结构，不渲染；忽略加密以尽量读取） */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await loadPdfLib()
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return doc.getPageCount()
}

/** 按页范围切出分片字节数组（顺序与 parts 一致） */
export async function splitPdf(bytes: Uint8Array, parts: PageRange[]): Promise<Uint8Array[]> {
  const { PDFDocument } = await loadPdfLib()
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const out: Uint8Array[] = []
  for (const { start, end } of parts) {
    const doc = await PDFDocument.create()
    const indices: number[] = []
    for (let p = start; p <= end; p += 1) indices.push(p - 1) // pdf-lib 用 0-based
    const copied = await doc.copyPages(src, indices)
    for (const page of copied) doc.addPage(page)
    out.push(await doc.save())
  }
  return out
}

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '')
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.')
  return dot >= 0 ? p.slice(dot).toLowerCase() : ''
}

const MD_IMAGE_RE = /(!\[[^\]]*\]\()([^)]+)(\))/g

/** 图片扁平化：把分片图片改名 p{i}_{name} 收集进 mergedImages；返回 basename→新名 映射 */
function flattenImages(outputs: ExtractedOutputs, partIndex: number, mergedImages: Map<string, ExtractedFile>): Record<string, string> {
  const mapping: Record<string, string> = {}
  for (const imgPath of outputs.imageFiles) {
    const file = outputs.files.find((f) => f.path === imgPath)
    if (!file) continue
    const newName = `p${partIndex}_${basename(imgPath)}`
    const newPath = `images/${newName}`
    if (!mergedImages.has(newPath)) mergedImages.set(newPath, { path: newPath, data: file.data })
    mapping[basename(imgPath)] = newPath
  }
  return mapping
}

/** 重写 Markdown 图片引用中的 basename → 扁平化新名 */
function rewriteMarkdownLinks(text: string, mapping: Record<string, string>): string {
  return text.replace(MD_IMAGE_RE, (match: string, pre: string, target: string, post: string) => {
    const name = basename(String(target).replace(/\\/g, '/'))
    const mapped = mapping[name]
    return mapped ? `${pre}${mapped}${post}` : match
  })
}

/** content_list 递归处理：page_idx 加偏移、img_path 按映射改写 */
function offsetBlocks(value: unknown, offset: number, mapping: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => offsetBlocks(item, offset, mapping))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'page_idx' && typeof item === 'number') out[key] = item + offset
      else if (key === 'img_path' && typeof item === 'string') {
        const name = basename(item.replace(/\\/g, '/'))
        out[key] = mapping[name] ?? item
      } else out[key] = offsetBlocks(item, offset, mapping)
    }
    return out
  }
  return value
}

function textOf(file: ExtractedFile | undefined): string {
  return file ? new TextDecoder().decode(file.data) : ''
}

/**
 * 合并多个分片产物为一个逻辑输出（full.md + images/ + _content_list.json）。
 * full.md 以 "\n\n" 拼接（OT 口径）；图片跨分片同名按分片序号前缀区分；page_idx 加偏移。
 */
export function mergeResults(parts: MergePart[]): ExtractedOutputs {
  log('info', 'splitter', 'merge.enter', { partCount: parts.length, pages: parts.reduce((s, p) => s + p.pageCount, 0) })
  const mdParts: string[] = []
  const blocks: unknown[] = []
  const mergedImages = new Map<string, ExtractedFile>()
  let offset = 0

  parts.forEach((part, index) => {
    const mapping = flattenImages(part.outputs, index, mergedImages)

    const mdPath = firstMarkdown(part.outputs)
    if (mdPath) {
      const mdFile = part.outputs.files.find((f) => f.path === mdPath)
      if (mdFile) mdParts.push(rewriteMarkdownLinks(textOf(mdFile), mapping))
    }

    const jsonPath = pickFinalContentJson(part.outputs)
    if (jsonPath) {
      const jsonFile = part.outputs.files.find((f) => f.path === jsonPath)
      if (jsonFile) {
        try {
          const payload: unknown = JSON.parse(textOf(jsonFile))
          if (Array.isArray(payload)) blocks.push(...(offsetBlocks(payload, offset, mapping) as unknown[]))
        } catch {
          // 单个分片 JSON 损坏不阻断其余合并
        }
      }
    }

    offset += part.pageCount
  })

  const files: ExtractedFile[] = [
    { path: 'full.md', data: new TextEncoder().encode(mdParts.join('\n\n')) },
    { path: '_content_list.json', data: new TextEncoder().encode(JSON.stringify(blocks, null, 2)) },
    ...mergedImages.values(),
  ]
  const result = scanOutputs(files)
  log('info', 'splitter', 'merge.done', { fileCount: result.files.length })
  return result
}

/** 供 pipeline 判断错误是否为「页数超限」（-60006）——只此码触发拆分（P-4） */
export function isPageLimitError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === '-60006'
}

export { extOf }

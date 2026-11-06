// M05 · core/output/locate — 产物定位（T1-12）
// 分类扫描与优先序参照 OT-X045/046/206/354（scan_outputs / extract_outputs）。
// MIT License — 改编自 MinerU-OCR-Tool（src/mineru_ocr_tool/client.py:486-546，
// 许可证经 D-29 用户确认为 MIT；保留原始版权声明与 LICENSE）。

import { BmuError } from '../client/errors'
import type { ExtractedFile, ExtractedOutputs } from '../types'

const MARKDOWN_EXT = '.md'
const JSON_EXT = '.json'
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp'])

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot).toLowerCase() : ''
}

/** 按扩展名分类扫描（OT-X scan_outputs 语义；排序保证确定性） */
export function scanOutputs(files: ExtractedFile[]): ExtractedOutputs {
  const outputs: ExtractedOutputs = { files, markdownFiles: [], jsonFiles: [], imageFiles: [] }
  for (const file of files) {
    const ext = extOf(file.path)
    if (ext === MARKDOWN_EXT) outputs.markdownFiles.push(file.path)
    else if (ext === JSON_EXT) outputs.jsonFiles.push(file.path)
    else if (IMAGE_EXTS.has(ext)) outputs.imageFiles.push(file.path)
  }
  outputs.markdownFiles.sort()
  outputs.jsonFiles.sort()
  outputs.imageFiles.sort()
  return outputs
}

/**
 * 定位唯一 Markdown：优先根目录 full.md，其后层级最浅的 .md，再按名称序。
 * 无 Markdown → 明确业务错误（T1-12 验收）。
 */
export function firstMarkdown(outputs: ExtractedOutputs): string | null {
  const full = outputs.markdownFiles.find((p) => p.toLowerCase() === 'full.md')
  if (full) return full
  if (outputs.markdownFiles.length === 0) return null
  const shallowest = [...outputs.markdownFiles].sort((a, b) => {
    const depthDiff = a.split('/').length - b.split('/').length
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b)
  })
  return shallowest[0]
}

/** 定位 content_list JSON：优先 `_content_list.json`，其后任意 *content_list*.json */
export function pickFinalContentJson(outputs: ExtractedOutputs): string | null {
  const preferred = outputs.jsonFiles.find((p) => p.toLowerCase().endsWith('_content_list.json'))
  if (preferred) return preferred
  return outputs.jsonFiles.find((p) => /content[_-]?list/i.test(p)) ?? null
}

/** 定位 + 校验：无 Markdown 抛错（T1-12：无 Markdown 时给出明确错误） */
export function locateOutputs(outputs: ExtractedOutputs): { markdown: string; contentJson: string | null } {
  const markdown = firstMarkdown(outputs)
  if (markdown === null) {
    throw new BmuError('business', '解析产物中未找到 Markdown 文件（ZIP 内无 .md）。', { code: 'NO_MARKDOWN' })
  }
  return { markdown, contentJson: pickFinalContentJson(outputs) }
}

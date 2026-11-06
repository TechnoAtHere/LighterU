// M05 · core/output/unzip — ZIP 解包三重限额 + 路径穿越防护（T1-11）
// 限额语义与拒绝行为参照 OT-X047 safe_extract_zip（OT-C050~052：20000 项 / 2GiB / 512MiB）；
// 解压用 fflate unzipSync（plan/01 §六：Python zipfile → fflate）。
// MIT License — 改编自 MinerU-OCR-Tool（src/mineru_ocr_tool/client.py:549-... safe_extract_zip，
// 许可证经 D-29 用户确认为 MIT；保留原始版权声明与 LICENSE）。

import { unzipSync } from 'fflate'
import { BmuError } from '../client/errors'
import type { ExtractedFile } from '../types'

export interface ZipLimits {
  maxZipEntries: number
  maxZipTotalBytes: number
  maxZipFileBytes: number
}

/** ZIP 内条目名清洗：拒绝绝对路径 / 盘符 / `..` 穿越（OT-X + MB-X040 sanitizeZipPath 思路） */
export function sanitizeZipPath(name: string): string {
  const unified = name.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw new BmuError('business', `ZIP 含绝对路径条目，已拒绝：${name}`, { code: 'ZIP_UNSAFE_PATH' })
  }
  const segments: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new BmuError('business', `ZIP 含路径穿越条目，已拒绝：${name}`, { code: 'ZIP_UNSAFE_PATH' })
    }
    segments.push(segment)
  }
  if (segments.length === 0) throw new BmuError('business', `ZIP 条目名为空：${name}`, { code: 'ZIP_UNSAFE_PATH' })
  return segments.join('/')
}

/**
 * 安全解包到内存（不落盘；限额在写盘前校验，超限即拒且不产生任何文件）。
 * 三重限额：条目数 / 解压总大小 / 单文件大小。
 */
export function safeExtractZip(data: Uint8Array, limits: ZipLimits): ExtractedFile[] {
  // 先按压缩包体积兜底（解压前），降低超大/恶意 ZIP 直接吃满内存的风险
  if (data.length > limits.maxZipTotalBytes) {
    throw new BmuError('limit', `ZIP 压缩包过大：${data.length} > ${limits.maxZipTotalBytes} 字节`, { code: 'ZIP_LIMIT_COMPRESSED' })
  }
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(data)
  } catch (err) {
    throw new BmuError('business', `ZIP 解压失败：${err instanceof Error ? err.message : String(err)}`, {
      code: 'ZIP_INVALID', cause: err,
    })
  }

  const names = Object.keys(unzipped).filter((name) => !name.endsWith('/'))
  if (names.length > limits.maxZipEntries) {
    throw new BmuError('limit', `ZIP 条目数超限：${names.length} > ${limits.maxZipEntries}`, { code: 'ZIP_LIMIT_ENTRIES' })
  }

  const files: ExtractedFile[] = []
  let total = 0
  for (const name of names) {
    const content = unzipped[name]
    if (content.length > limits.maxZipFileBytes) {
      throw new BmuError('limit', `ZIP 单文件超限：${name}（${content.length} > ${limits.maxZipFileBytes} 字节）`, { code: 'ZIP_LIMIT_FILE' })
    }
    total += content.length
    if (total > limits.maxZipTotalBytes) {
      throw new BmuError('limit', `ZIP 解压总大小超限：> ${limits.maxZipTotalBytes} 字节`, { code: 'ZIP_LIMIT_TOTAL' })
    }
    files.push({ path: sanitizeZipPath(name), data: content })
  }
  return files
}

// M05 · core/output/write — 输出落盘：唯一目录 / Windows 保留名 / 长路径（T1-13）
// 语义参照 OT-X388/389/385 + paths.py:27-85（MIT，D-29 确认；保留原始版权声明与 LICENSE）。

import { BmuError } from '../client/errors'
import type { ExtractedFile, OutputFormat, OutputKind, SameNameHandling, WriteResult } from '../types'
import type { FsAdapter } from '../platform/fs'

/** DOS 设备名：base name（首个点之前）命中即视为设备（OT-X paths.py:27-31） */
const RESERVED_WINDOWS_DEVICE_NAMES = new Set(
  ['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)],
)

/** base（首个点之前，大写）是否为 DOS 设备名（OT-X is_reserved_windows_name） */
export function isReservedWindowsName(name: string): boolean {
  return RESERVED_WINDOWS_DEVICE_NAMES.has(name.split('.', 1)[0].toUpperCase())
}

/** 保留名加 `_` 前缀使其可真实落盘（"CON" → "_CON"；OT-X escape_reserved_name） */
export function escapeReservedName(name: string): string {
  return isReservedWindowsName(name) ? `_${name}` : name
}

/**
 * 清洗目录/文件基名：非法字符（<>:"/\|?* 与控制符）替换为 `_`，
 * 去首尾空白与点（OT-X _safe_stem 语义），保留名转义，空名回退 "doc"。
 */
export function sanitizeStem(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/^[ ._]+|[ ._]+$/g, '')
  return escapeReservedName(cleaned) || 'doc'
}

/** 取不含扩展名的基名（兼容无点文件名） */
export function stemOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '')
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** 取父目录（无分隔符时返回 '.'） */
export function dirNameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx > 0 ? path.slice(0, idx) : '.'
}

/**
 * 唯一目录：已存在则追加 `_N` 序号（OT-X unique_path / make_unique_task_dir 语义）。
 * 返回**未创建**的候选路径（创建由写入方完成）。
 */
export async function uniqueDirPath(fs: FsAdapter, candidate: string): Promise<string> {
  if (!(await fs.exists(candidate))) return candidate
  const parent = dirNameOf(candidate)
  const base = candidate.slice(parent.length + 1)
  for (let index = 1; index < 10_000; index += 1) {
    const next = `${parent}/${base}_${index}`
    if (!(await fs.exists(next))) return next
  }
  throw new BmuError('internal', `无法为输出目录生成唯一名称：${candidate}`)
}

/** 相对路径清洗：统一分隔符、拒绝穿越与绝对路径（写入前最后一道防线） */
export function sanitizeRelativePath(relPath: string): string {
  const unified = relPath.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw new BmuError('business', `拒绝写入绝对路径条目：${relPath}`, { code: 'ZIP_UNSAFE_PATH' })
  }
  const segments: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new BmuError('business', `拒绝写入路径穿越条目：${relPath}`, { code: 'ZIP_UNSAFE_PATH' })
    }
    segments.push(escapeReservedName(segment))
  }
  if (segments.length === 0) throw new BmuError('business', `拒绝写入空路径条目：${relPath}`, { code: 'ZIP_UNSAFE_PATH' })
  return segments.join('/')
}

/** 参与「图片」输出的扩展名（与 caption 扫图口径一致） */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'])

/** T5-05/T5-02：writeOutputs 可选参数（均带安全默认，缺省 = 现状行为） */
export interface WriteOutputsOptions {
  /** 'markdown' 仅写 .md（full.md）；'all'（默认）写全部产物（full.md + JSON + images） */
  format?: OutputFormat
  /** D-98：只写选中的内容类型（多选）；缺省 = 按 format 行为 */
  kinds?: OutputKind[]
  /** 'suffix'（默认）唯一目录（冲突追加 _N）；'overwrite' 直接用候选目录（覆盖同名） */
  sameName?: SameNameHandling
}

/** 唯一文件路径：已存在则插入 `_N`（overwrite 由调用方决定不走此函数） */
async function uniqueFilePath(fs: FsAdapter, candidate: string): Promise<string> {
  if (!(await fs.exists(candidate))) return candidate
  const idx = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\'))
  const parent = idx > 0 ? candidate.slice(0, idx) : '.'
  const name = idx > 0 ? candidate.slice(idx + 1) : candidate
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 10_000; i += 1) {
    const next = `${parent}/${base}_${i}${ext}`
    if (!(await fs.exists(next))) return next
  }
  return candidate
}

/** D-98：按扩展名判定该产物是否属于选中类型（未识别的中间产物随「图片」保留，避免 md 引用失效） */
function keepKind(rel: string, kinds: OutputKind[]): boolean {
  const lower = rel.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  if (ext === 'md') return kinds.includes('markdown')
  if (ext === 'json') return kinds.includes('json')
  if (ext === 'docx') return kinds.includes('docx')
  if (ext === 'html' || ext === 'htm') return kinds.includes('html')
  if (IMAGE_EXTS.has(ext)) return kinds.includes('images')
  return kinds.includes('images')
}

/**
 * 将解包结果写入输出（T1-13 + T5-05 格式 + T5-02 同名处理 + T5-F markdown 单文件 + D-98 多选）。
 * - 仅 Markdown：直接把命名好的 `<stem>.md` 写到 destDir
 * - 其余：完整产物进唯一子目录，并按 kinds 过滤
 */
export async function writeOutputs(
  fs: FsAdapter,
  files: ExtractedFile[],
  destDir: string,
  baseName: string,
  opts?: WriteOutputsOptions,
): Promise<WriteResult> {
  const format: OutputFormat = opts?.format ?? 'all'
  const sameName: SameNameHandling = opts?.sameName ?? 'suffix'
  const kinds = opts?.kinds
  const stem = sanitizeStem(baseName)
  const dest = toPosix(destDir)
  const markdownOnly = kinds !== undefined ? kinds.length === 1 && kinds[0] === 'markdown' : format === 'markdown'

  // T5-F：仅 Markdown —— 目标目录下直接一个命名好的 .md
  if (markdownOnly) {
    const mdFile = files.find((f) => f.path.toLowerCase().endsWith('.md'))
    if (!mdFile) {
      const outputDir = sameName === 'overwrite' ? `${dest}/${stem}` : await uniqueDirPath(fs, `${dest}/${stem}`)
      await fs.ensureDir(outputDir)
      return { outputDir, markdownPath: null }
    }
    await fs.ensureDir(dest)
    let target = `${dest}/${stem}.md`
    if (sameName !== 'overwrite') target = await uniqueFilePath(fs, target)
    await fs.writeFileBytes(target, mdFile.data)
    return { outputDir: dest, markdownPath: target }
  }

  const candidate = `${dest}/${stem}`
  const outputDir = sameName === 'overwrite' ? candidate : await uniqueDirPath(fs, candidate)
  await fs.ensureDir(outputDir)

  let markdownPath: string | null = null
  for (const file of files) {
    const rel = sanitizeRelativePath(file.path)
    // D-98：多选过滤（kinds 缺省时全写，保持旧行为）
    if (kinds !== undefined && !keepKind(rel, kinds)) continue
    const target = `${outputDir}/${rel}`
    await fs.writeFileBytes(target, file.data)
    if (markdownPath === null && rel.toLowerCase().endsWith('.md')) {
      markdownPath = target
    }
  }
  return { outputDir, markdownPath }
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

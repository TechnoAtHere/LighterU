// M03 · core/pipeline — 单文件解析编排：提交 → 轮询 → 下载 → 解压 → 定位 → 落盘（T1-14）
// Runner 契约签名参照 OT-X403/404 与 TS-X029；download 到 done 即下、404 按 task_id 重查一次（D-27）；
// 取消检查点：轮询每轮 + 下载/解压/落盘前（T1-15）。
// T3-09：提交返回 -60006（页数超限）时进入自动拆分分支（plan/04 P-4）；≤200 页正常路径不变。
// T3-08：上传成功后把 data_id/fingerprint/options_hash 回写 store.task_files；启动时按指纹+选项续传跳过上传。
// MIT License — 契约改编自 MinerU-OCR-Tool（src/mineru_ocr_tool/client.py:70-114 Runner，
// 许可证经 D-29 用户确认为 MIT；保留原始版权声明与 LICENSE；按 D-07 以 TypeScript 重写。

import { dirNameOf, firstMarkdown, locateOutputs, safeExtractZip, scanOutputs, stemOf, writeOutputs } from '../output'
import { MinerUCloudClient } from '../client/mineru-cloud'
import { MinerUAgentClient } from '../client/mineru-agent'
import { log as blog } from '../platform/logger'
import { pushUserMessage, concludeUserMessage } from '../platform/user-feed'
import { toUserMessageOrGeneric } from '../platform/user-messages'
import { BmuError, isBmuError } from '../client/errors'
import { withRetry, defaultShouldRetry } from '../client/retry'
import { normalizeState } from '../client/compat'
import { fingerprint } from '../caption/fingerprint'
import { hashOptions, isResumeCompatible } from '../tasks/resume'
import {
  MAX_PAGES_PER_PART,
  countPdfPages,
  isPageLimitError,
  mergeResults,
  planParts,
  splitPdf,
} from '../splitter'
import type { MergePart, PageRange } from '../splitter'
import type { FsAdapter } from '../platform/fs'
import type { HttpTransport } from '../platform/http'
import type { Store } from '../store'
import type {
  AppConfig,
  CloudState,
  ExtractedFile,
  ExtractedOutputs,
  OutputFormat,
  OutputKind,
  ParseOptions,
  PipelineCallback,
  PipelineInput,
  PipelinePhase,
  PipelineResult,
  SameNameHandling,
} from '../types'

export interface RunJobDeps {
  config: AppConfig
  transport: HttpTransport
  fs: FsAdapter
  onEvent: PipelineCallback
  signal: AbortSignal
  /** T3-08：传入则在断点续传判定 + 上传状态回写时生效；undefined 时静默跳过（headless 无 store） */
  store?: Store
  /** T3-08：与 store 配套的任务 id（Job id），用于定位 task_files 行 */
  taskId?: string
  /** D-42：输出目录覆盖（输出目录行内修改 / 解析到…）；不传按原逻辑计算 */
  destDirOverride?: string
  /** T5-05/D-61：输出格式（markdown/all）；不传 = all（现状） */
  outputFormat?: OutputFormat
  /** T5-02/D-62：同名输出目录处理；不传 = suffix（现状） */
  sameNameHandling?: SameNameHandling
  /**
   * D-97：本次解析后会自动运行图片描述。
   * 为 true 时强制落盘完整产物——否则「仅 Markdown」只写 .md，图片被丢弃，图片描述无图可读。
   */
  captionEnabled?: boolean
  /** D-98：输出内容多选（markdown/json/docx/html/images）；缺省 = 按 outputFormat 旧行为 */
  outputs?: OutputKind[]
}

function throwIfAborted(signal: AbortSignal, stage: string): void {
  if (signal.aborted) throw new BmuError('canceled', '任务已取消。', { stage })
}

/** PDF 校验（D-14）：扩展名 + %PDF- 魔数；非 PDF 返回「暂不支持」 */
export function validatePdf(fileName: string, head: Uint8Array): void {
  if (!fileName.toLowerCase().endsWith('.pdf')) {
    throw new BmuError('unsupported', `暂不支持：仅支持 PDF 输入（收到 ${fileName || '未知文件'}）。`, { code: 'UNSUPPORTED_FORMAT' })
  }
  const window = head.subarray(0, Math.min(head.length, 1024))
  const text = new TextDecoder('latin1').decode(window)
  if (!text.includes('%PDF-')) {
    throw new BmuError('unsupported', '暂不支持：该文件不是有效 PDF（缺少 %PDF- 文件头）。', { code: 'UNSUPPORTED_FORMAT' })
  }
}

/** 支持的输入扩展名（精准解析：PDF / 图片 / Office；Agent 轻量同表，单次上传 ≤10MB、≤20 页，长 PDF 自动拆分） */
export const SUPPORTED_INPUT_EXTS = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'jp2',
  'webp',
  'gif',
  'bmp',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
] as const

/**
 * 输入校验：扩展名白名单；PDF 额外校验 %PDF- 魔数（D-14）。
 * 非 PDF（图片 / Office）交由 MinerU 服务端解析，本地只做基础拦截。
 */
export function validateInput(fileName: string, head: Uint8Array): void {
  const ext = (fileName.toLowerCase().split('.').pop() ?? '').trim()
  if (!(SUPPORTED_INPUT_EXTS as readonly string[]).includes(ext)) {
    throw new BmuError(
      'unsupported',
      `暂不支持该格式：${fileName || '未知文件'}（支持 PDF、图片 png/jpg/jpeg/jp2/webp/gif/bmp、Doc/Docx/PPT/PPTx/Xls/Xlsx）。`,
      { code: 'UNSUPPORTED_FORMAT' },
    )
  }
  if (ext === 'pdf') validatePdf(fileName, head)
}

/** 选中 JSON / docx / html 等附加产物时，按完整产物落盘（否则只写 full.md） */
function effectiveOutputFormat(deps: RunJobDeps): OutputFormat {
  const p = deps.config.mineru.parse
  if (p.extraFormats.length > 0 || p.includeJson) return 'all'
  // D-97：启用图片描述时必须落盘图片（仅 Markdown 只写 .md，图片描述将无图可读）
  if (deps.captionEnabled) return 'all'
  // D-98：多选里只要含 Markdown 以外的内容，就必须走「完整产物」分支再按 kinds 过滤
  if (deps.outputs && deps.outputs.some((k) => k !== 'markdown')) return 'all'
  return deps.outputFormat ?? 'all'
}

/** D-99：图片描述必须能读到图片——即使未勾选「图片」，也要临时落盘 images/ 供读图 */
function effectiveKinds(deps: RunJobDeps): OutputKind[] | undefined {
  if (!deps.outputs) return undefined
  if (deps.captionEnabled && !deps.outputs.includes('images')) return [...deps.outputs, 'images']
  return deps.outputs
}

/**
 * D-98：按输出多选推导本次请求的解析选项。
 * DOCX / HTML 需由服务端生成（extra_formats），因此在请求阶段就要声明；
 * JSON 随结果 ZIP 返回，仅用于落盘过滤，不写入 extra_formats。
 */
function effectiveParseOptions(deps: RunJobDeps): ParseOptions {
  const base = deps.config.mineru.parse
  const outputs = deps.outputs
  if (!outputs || outputs.length === 0) return base
  const extra: string[] = []
  if (outputs.includes('docx')) extra.push('docx')
  if (outputs.includes('html')) extra.push('html')
  return { ...base, extraFormats: extra, includeJson: outputs.includes('json') }
}

function basenameOf(path: string): string {
  return path.replace(/^.*[\\/]/, '')
}

function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(0, i) : ''
}

/** 把已下载分片产物写入 debug 目录（T3-09：任一分片失败时保留，供排查；只写不删） */
async function retainParts(fs: FsAdapter, debugDir: string, collected: MergePart[]): Promise<void> {
  for (let i = 0; i < collected.length; i += 1) {
    for (const file of collected[i].outputs.files) {
      const target = `${debugDir}/part_${i + 1}/${file.path}`
      try {
        await fs.ensureDir(dirName(target))
        await fs.writeFileBytes(target, file.data)
      } catch {
        // 保留失败不影响主错误抛出
      }
    }
  }
}

/** 通用编排器传给各模式配置的单片上下文 */
interface SplitPartArgs {
  partName: string
  partBytes: Uint8Array
  partIndex: number
  partCount: number
  pageRange: PageRange
  deps: RunJobDeps
  signal: AbortSignal
  onPhase: (p: PipelinePhase) => void
  onLog: (message: string) => void
  onProgress: (p: { extractedPages?: number; totalPages?: number; cloudState?: CloudState }) => void
}

interface SplitPartOutcome<P> {
  output: P
  /** 上传批次 id（Agent 无独立批次，复用 taskId） */
  batchId: string
  /** 云端任务 id */
  taskId: string
}

interface SplitMergeResult {
  files: ExtractedFile[]
  /** writeOutputs 未给出 markdownPath 时的兜底 */
  fallbackMarkdownPath: string | null
}

/**
 * 解析模式的差异全部收在这里；拆分编排逻辑只有 runSplitWithProfile 一份。
 * 精准与 Agent 只传入不同的 SplitProfile（分片大小、单片提交/下载、合并语义、落盘选项、失败保留）。
 */
interface SplitProfile<P> {
  mode: 'precise' | 'agent'
  maxPagesPerPart: number
  maxPartBytes: number
  partTooLarge(bytes: number, index: number): BmuError
  onBeforeSplit?(deps: RunJobDeps, onLog: (message: string) => void): void
  runPart(args: SplitPartArgs): Promise<SplitPartOutcome<P>>
  merge(parts: P[]): SplitMergeResult
  writeOptions(deps: RunJobDeps): { format: OutputFormat; kinds?: OutputKind[]; sameName?: SameNameHandling }
  retainOnFailure?(args: { parts: P[]; destDir: string; deps: RunJobDeps }): Promise<void>
}

/** 共用的自动拆分编排：count → plan → split → 逐片 runPart → merge → writeOutputs。 */
async function runSplitWithProfile<P>(
  profile: SplitProfile<P>,
  deps: RunJobDeps,
  bytes: Uint8Array,
  fileName: string,
  destDir: string,
  startedAt: number,
  totalPages: number,
): Promise<PipelineResult> {
  const { fs, onEvent, signal } = deps
  const log = (message: string) => onEvent({ type: 'log', message })
  const phase = (p: PipelinePhase) => onEvent({ type: 'phase', phase: p })
  const stem = stemOf(fileName)

  const ranges = planParts(totalPages, profile.maxPagesPerPart)
  log(`PDF 共 ${totalPages} 页，超过 ${profile.maxPagesPerPart} 页上限，拆分为 ${ranges.length} 个分片`)
  profile.onBeforeSplit?.(deps, log)
  const partBytes = await splitPdf(bytes, ranges)

  const splitId = `split-${fileName}`
  pushUserMessage(toUserMessageOrGeneric('split.progress', {}), { id: splitId })
  const collected: P[] = []
  try {
    let firstBatchId = ''
    let lastTaskId = ''
    for (let i = 0; i < ranges.length; i += 1) {
      throwIfAborted(signal, 'uploading')
      const partName = `split_part_${i + 1}.pdf`
      if (partBytes[i].length > profile.maxPartBytes) {
        throw profile.partTooLarge(partBytes[i].length, i + 1)
      }
      phase('uploading')
      log(`提交分片 ${i + 1}/${ranges.length}（第 ${ranges[i].start}-${ranges[i].end} 页）`)
      // 状态列显示「解析中（1/4）」：分片进度经任务层写入 Job.progress
      onEvent({ type: 'progress', partIndex: i + 1, partTotal: ranges.length })
      const part = await profile.runPart({
        partName,
        partBytes: partBytes[i],
        partIndex: i,
        partCount: ranges.length,
        pageRange: ranges[i],
        deps,
        signal,
        onPhase: phase,
        onLog: log,
        onProgress: (p) => onEvent({ type: 'progress', ...p }),
      })
      collected.push(part.output)
      if (i === 0) firstBatchId = part.batchId
      lastTaskId = part.taskId
    }

    const merged = profile.merge(collected)
    phase('writing')
    throwIfAborted(signal, 'writing')
    const result = await writeOutputs(fs, merged.files, destDir, stem, profile.writeOptions(deps))
    concludeUserMessage(splitId, toUserMessageOrGeneric('split.done', { count: ranges.length }))
    log(`已合并 ${ranges.length} 个分片并写入：${result.markdownPath ?? result.outputDir}`)
    phase('done')
    const kb = Math.round(merged.files.reduce((s, f) => s + f.data.length, 0) / 1024)
    blog('info', 'pipeline', 'split.done', { mode: profile.mode, parts: ranges.length, taskId: lastTaskId, kb })
    return {
      outputDir: result.outputDir,
      markdownPath: result.markdownPath ?? merged.fallbackMarkdownPath,
      batchId: firstBatchId,
      taskId: lastTaskId,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    await profile.retainOnFailure?.({ parts: collected, destDir, deps })
    concludeUserMessage(splitId, toUserMessageOrGeneric('generic.error', { message: `自动拆分失败：${err instanceof Error ? err.message : String(err)}` }))
    throw err
  }
}

/** 精准解析配置：200 页一片，ZIP 产物经 mergeResults 合并 full.md / content_list / images。 */
function preciseSplitProfile(client: MinerUCloudClient): SplitProfile<MergePart> {
  return {
    mode: 'precise',
    maxPagesPerPart: MAX_PAGES_PER_PART,
    maxPartBytes: 200 * 1024 * 1024,
    partTooLarge: (n, i) => new BmuError('limit', `分片 ${i} 超过精准解析 200MB 上限（${(n / 1024 / 1024).toFixed(1)}MB）。`, { code: 'PART_TOO_LARGE', stage: 'validating' }),
    onBeforeSplit: (d, log) => {
      // mergeResults 只合并 Markdown / JSON / 图片；DOCX / HTML 分片产出无法合并，明确告知。
      if (d.config.mineru.parse.extraFormats.length > 0) {
        log('自动拆分路径仅合并 Markdown / JSON / 图片，DOCX / HTML 等额外格式在本次不会产出')
      }
    },
    runPart: async ({ partName, partBytes, pageRange, deps, signal, onPhase, onProgress }) => {
      const { config } = deps
      // 分片只用于合并 Markdown / JSON / 图片，故不注入 extra_formats。
      const { batchId, uploadUrl } = await client.requestUploadUrl(
        { fileName: partName, parse: { ...config.mineru.parse, extraFormats: [] } },
        signal,
      )
      await client.uploadFile(uploadUrl, partBytes, signal)

      onPhase('polling')
      const status = await client.waitForCompletion(batchId, {
        signal,
        onProgress: (s) => onProgress({
          extractedPages: s.extractedPages ?? undefined,
          totalPages: s.totalPages ?? undefined,
          cloudState: s.state,
        }),
      })
      onPhase('downloading')
      throwIfAborted(signal, 'downloading')
      const zipBytes = await client.downloadResultWithFallback(status, () => client.getTaskStatus(status.taskId, signal), signal)

      onPhase('extracting')
      throwIfAborted(signal, 'extracting')
      const files = safeExtractZip(zipBytes, config.limits)
      return {
        output: { outputs: scanOutputs(files), pageCount: pageRange.end - pageRange.start + 1 },
        batchId,
        taskId: status.taskId,
      }
    },
    merge: (parts) => {
      const merged = mergeResults(parts)
      return { files: merged.files, fallbackMarkdownPath: firstMarkdown(merged) }
    },
    // 图片解析保护：captionEnabled 时强制落盘完整产物（D-97/D-99），必须原样保留。
    writeOptions: (d) => ({ format: effectiveOutputFormat(d), kinds: effectiveKinds(d), sameName: d.sameNameHandling }),
    retainOnFailure: async ({ parts, destDir, deps }) => {
      const debugDir = `${destDir.replace(/[\\/]+$/, '')}/_lusplit_debug`
      await retainParts(deps.fs, debugDir, parts)
    },
  }
}

/** Agent 轻量 API 单文件页数/体积上限（自动拆分时按 20 页一片切分） */
const MAX_AGENT_PAGES_PER_PART = 20
const AGENT_MAX_BYTES = 10 * 1024 * 1024

/** 按分片顺序拼接 Markdown：与 mergeResults 的 full.md "\n\n" 口径一致，按字节拼避免编解码损耗。 */
function joinMarkdownParts(parts: Uint8Array[]): Uint8Array {
  const sep = new TextEncoder().encode('\n\n')
  const total = parts.reduce((s, p) => s + p.length, 0) + sep.length * Math.max(0, parts.length - 1)
  const out = new Uint8Array(total)
  let off = 0
  parts.forEach((p, i) => {
    if (i > 0) {
      out.set(sep, off)
      off += sep.length
    }
    out.set(p, off)
    off += p.length
  })
  return out
}

/** Agent 配置：20 页一片，逐片返回的 Markdown 按序拼接为一份 full.md。 */
function agentSplitProfile(client: MinerUAgentClient): SplitProfile<Uint8Array> {
  return {
    mode: 'agent',
    maxPagesPerPart: MAX_AGENT_PAGES_PER_PART,
    maxPartBytes: AGENT_MAX_BYTES,
    partTooLarge: (n, i) => new BmuError('limit', `分片 ${i} 仍超过 Agent 单文件 10MB 上限（${(n / 1024 / 1024).toFixed(1)}MB）——请到「设置 → MinerU」切换为「精准解析 API」。`, { code: 'AGENT_PART_TOO_LARGE', stage: 'validating' }),
    runPart: async ({ partName, partBytes, partIndex, deps, signal, onPhase, onLog, onProgress }) => {
      const { config } = deps
      // 已本地切分：清掉 page_range，避免服务端二次截取导致内容错乱。
      const partParse: ParseOptions = { ...config.mineru.parse, pageRanges: '' }
      // 分片数增多会放大 IP 限频（429）：仅对提交做退避重试。
      const sub = await withRetry(() => client.submitFile(partName, partParse, signal), {
        maxAttempts: Math.max(1, config.mineru.maxAttempts),
        stage: 'agent/parse/file',
        signal,
        shouldRetry: defaultShouldRetry,
        onRetry: (attempt, delay) => onLog(`分片 ${partIndex + 1} 提交被限流，${delay.toFixed(1)}s 后重试（第 ${attempt} 次）`),
      })
      await client.upload(sub.fileUrl, partBytes, signal)

      onPhase('polling')
      const status = await client.waitForTask(sub.taskId, {
        signal,
        // Agent 的 waiting-file / pending / running / done / failed 也归一到统一云端状态
        onStatus: (s) => onProgress({ cloudState: normalizeState(s.state) }),
      })
      onPhase('downloading')
      throwIfAborted(signal, 'downloading')
      const md = await client.downloadMarkdown(status.markdownUrl as string, signal)
      // Agent 无独立批次 id，batchId 复用 taskId（与原实现一致）。
      return { output: md, batchId: sub.taskId, taskId: sub.taskId }
    },
    merge: (parts) => ({ files: [{ path: 'full.md', data: joinMarkdownParts(parts) }], fallbackMarkdownPath: null }),
    writeOptions: (d) => ({ format: 'markdown', sameName: d.sameNameHandling }),
  }
}

/**
 * Agent 轻量解析分支（免 Token）：提交 → 签名上传 → 轮询 → 下载 markdown_url → 落盘 <stem>.md。
 * 单文件 ≤10MB；PDF 超过 20 页时与精准模式一致自动拆分、逐片上传并合并 Markdown。
 */
async function runAgentJob(
  input: PipelineInput,
  deps: RunJobDeps,
  bytes: Uint8Array,
  destDir: string,
  startedAt: number,
): Promise<PipelineResult> {
  const { config, transport, fs, onEvent, signal } = deps
  const log = (message: string) => onEvent({ type: 'log', message })
  const phase = (p: PipelinePhase) => onEvent({ type: 'phase', phase: p })
  const fileName = basenameOf(input.filePath) || input.filePath
  const ext = (fileName.toLowerCase().split('.').pop() ?? '').trim()
  const mb = bytes.length / (1024 * 1024)

  // Agent 仅返回 Markdown 文本、无图片目录：把「用户勾选但不生效」的选项显式告知，避免静默失效。
  if (deps.outputs && deps.outputs.some((k) => k !== 'markdown')) {
    log('Agent 轻量解析仅输出 Markdown；已忽略 JSON / DOCX / HTML / 图片等输出选项')
  }
  if (deps.captionEnabled) {
    log('Agent 轻量解析不返回图片目录，图片描述在本次不会执行')
  }

  // Agent 轻量解析支持：PDF、图片、Docx/PPTx/Xls/Xlsx（不含旧版 doc/ppt）
  const AGENT_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp', 'docx', 'pptx', 'xls', 'xlsx']
  if (!AGENT_EXTS.includes(ext)) {
    throw new BmuError(
      'unsupported',
      `Agent 轻量解析不支持 .${ext}（仅支持 PDF、图片、Docx/PPTx/Xls/Xlsx）——请到「设置 → MinerU」切换为「精准解析 API」后重试。`,
      { code: 'AGENT_UNSUPPORTED_FORMAT', stage: 'validating' },
    )
  }

  const isPdf = ext === 'pdf'
  const userRange = config.mineru.parse.pageRanges.trim()
  let totalPages = 0
  if (isPdf) {
    try {
      totalPages = await countPdfPages(bytes)
    } catch (err) {
      if (isBmuError(err)) throw err
      // 页数解析失败不阻断（交由服务端判定）
      blog('warn', 'pipeline', 'agent.pageCountFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  const client = new MinerUAgentClient({ config, transport, onLog: log })

  // 与精准模式一致：超过 Agent 单文件页数上限 → 自动拆分、逐片上传、合并 Markdown。
  // 用户显式指定页码范围时不接管（交由服务端按范围解析），避免本地切分与 page_range 二次截取冲突。
  if (isPdf && !userRange && totalPages > MAX_AGENT_PAGES_PER_PART) {
    return await runSplitWithProfile(agentSplitProfile(client), deps, bytes, fileName, destDir, startedAt, totalPages)
  }
  if (isPdf && userRange && totalPages > MAX_AGENT_PAGES_PER_PART) {
    log(`已指定页码范围「${userRange}」，跳过自动拆分；若范围超过 ${MAX_AGENT_PAGES_PER_PART} 页可能被服务端拒绝`)
  }

  // 未进入拆分路径时才校验整文件体积（拆分后按每片单独校验）。
  if (bytes.length > AGENT_MAX_BYTES) {
    throw new BmuError('business', `Agent 轻量解析单文件上限 10MB（当前 ${mb.toFixed(1)}MB）——请到「设置 → MinerU」切换为「精准解析 API」后重试。`, {
      code: 'AGENT_FILE_TOO_LARGE',
      stage: 'validating',
    })
  }
  phase('uploading')
  const sub = await client.submitFile(fileName, config.mineru.parse, signal)
  log(`Agent 任务已提交（${sub.taskId}），正在上传…`)
  await client.upload(sub.fileUrl, bytes, signal)
  log('上传完成，等待解析…')

  phase('polling')
  let lastState = ''
  const status = await client.waitForTask(sub.taskId, {
    signal,
    onStatus: (s) => {
      if (s.state !== lastState) {
        lastState = s.state
        log(`Agent 状态：${s.state}`)
      }
    },
  })
  log('Agent 解析完成，下载 Markdown…')

  phase('downloading')
  const md = await client.downloadMarkdown(status.markdownUrl as string, signal)

  phase('writing')
  // 复用 writeOutputs 的 markdownOnly 分支：与精准模式共用同名处理（suffix / overwrite）和
  // markdownPath 定位，避免直接写 ${stem}.md 覆盖已有结果（原实现忽略 sameNameHandling）。
  const stem = stemOf(fileName)
  const result = await writeOutputs(fs, [{ path: 'full.md', data: md }], destDir, stem, {
    format: 'markdown',
    sameName: deps.sameNameHandling,
  })
  log(`已写入 ${result.markdownPath ?? destDir}`)
  phase('done')
  blog('info', 'pipeline', 'agent.done', { taskId: sub.taskId, kb: Math.round(md.length / 1024) })
  return {
    outputDir: result.outputDir,
    markdownPath: result.markdownPath,
    batchId: sub.taskId,
    taskId: sub.taskId,
    durationMs: Date.now() - startedAt,
  }
}

export async function runParseJob(input: PipelineInput, deps: RunJobDeps): Promise<PipelineResult> {
  const { config, transport, fs, onEvent, signal, store, taskId } = deps
  const startedAt = Date.now()
  const log = (message: string) => onEvent({ type: 'log', message })
  const phase = (p: PipelinePhase) => onEvent({ type: 'phase', phase: p })

  const fileName = basenameOf(input.filePath) || input.filePath
  blog('info', 'pipeline', 'runParseJob.enter', { file: fileName, entry: config.output.entry })
  const client = new MinerUCloudClient({
    // D-98：按输出多选推导请求选项（DOCX/HTML 需服务端生成，必须在请求阶段声明）
    config: { ...config, mineru: { ...config.mineru, parse: effectiveParseOptions(deps) } },
    transport,
    onLog: log,
  })
  // D-42：destDirOverride 存在则用它（输出目录行内修改/解析到…）；否则按原逻辑（不改行为）
  const destDir =
    deps.destDirOverride ??
    (config.output.entry === 'context-menu'
      ? dirNameOf(input.filePath)
      : config.output.outputDir || dirNameOf(input.filePath))
  const stem = stemOf(fileName)

  // 1) 校验 + 读取（D-14：非 PDF 在提交前拦截）
  phase('validating')
  throwIfAborted(signal, 'validating')
  phase('reading')
  // 读取前上限校验，避免超大文件整体读入内存导致 OOM。
  // Agent PDF（未指定页码范围）可自动拆分，预检放宽到 200MB，10MB 上限改由共用编排器按每片校验；
  // 其余 Agent 输入（图片/Office，无法按页拆分）仍保留 10MB 预检。
  const agentSplitCandidate = config.mineru.apiMode === 'agent'
    && input.filePath.toLowerCase().endsWith('.pdf')
    && !config.mineru.parse.pageRanges.trim()
  const sizeLimit = config.mineru.apiMode === 'agent' && !agentSplitCandidate
    ? 10 * 1024 * 1024
    : 200 * 1024 * 1024
  if (fs.stat) {
    try {
      const info = await fs.stat(input.filePath)
      if (info.size > sizeLimit) {
        throw new BmuError(
          'limit',
          `文件过大：${fileName}（${(info.size / 1024 / 1024).toFixed(1)}MB），当前模式上限 ${Math.round(sizeLimit / 1024 / 1024)}MB。`,
          { code: 'FILE_TOO_LARGE', stage: 'validating' },
        )
      }
    } catch (err) {
      if (isBmuError(err)) throw err
      // stat 不可用/失败不阻断（继续读取，由服务端兜底）
      blog('warn', 'pipeline', 'fileSize.statFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  }
  const bytes = await fs.readFileBytes(input.filePath)
  validateInput(fileName, bytes)
  log(`已读取 ${fileName}（${(bytes.length / 1024).toFixed(1)} KB）`)
  blog('debug', 'pipeline', 'read.done', { file: fileName, kb: Math.round(bytes.length / 1024) })

  // Agent 轻量解析：免 Token，单次上传 ≤10MB；>20 页 PDF 由共用编排器 + agentSplitProfile 拆分合并
  if (config.mineru.apiMode === 'agent') {
    blog('info', 'pipeline', 'agent.branch', { file: fileName })
    return await runAgentJob(input, deps, bytes, destDir, startedAt)
  }

  // T3-08：断点续传上下文（store 缺失时降级为不回写/不续传）
  const persist = store && taskId ? { store, taskId } : null
  const fp = fingerprint(bytes)
  const optionsHash = hashOptions({ ...config.mineru.parse, entry: config.output.entry })

  /** 精准模式自动拆分入口：本地页数预判与服务端 -60006 共用同一编排器与配置。 */
  const enterSplit = async (reason: string, totalPages?: number): Promise<PipelineResult> => {
    blog('debug', 'pipeline', 'upload.splitBranch', { file: fileName, reason })
    log(reason)
    // 本地预判已算过页数时直接复用，避免重复解析 PDF 结构。
    const pages = totalPages ?? await countPdfPages(bytes)
    return await runSplitWithProfile(preciseSplitProfile(client), deps, bytes, fileName, destDir, startedAt, pages)
  }

  // 2) 申请上传 URL + PUT（上传完成自动提交解析）；-60006 → 拆分分支
  phase('uploading')
  let reused = false
  let batchId = ''
  if (persist) {
    const stored = (await persist.store.loadFiles(persist.taskId)).find((f) => f.name === fileName)
    if (stored && stored.dataId && isResumeCompatible(stored, { fingerprint: fp, optionsHash })) {
      reused = true
      batchId = stored.dataId
      log(`断点续传：复用已上传批次 ${batchId}，跳过上传`)
      blog('debug', 'pipeline', 'upload.reused', { batchId })
      blog('trace', 'pipeline', 'resume.reused', { batchId, fingerprint: fp.slice(0, 12) })
    }
  }

  if (!reused) {
    // 兜底：真实服务可能在上传/轮询阶段才判页数超限，届时 -60006 已被包成 PARSE_FAILED 而丢失。
    // 对未指定页码范围的 PDF 先本地读页数，超限直接拆分，不依赖服务端错误码；读页数失败则降级走原路径。
    if (fileName.toLowerCase().endsWith('.pdf') && !config.mineru.parse.pageRanges.trim()) {
      try {
        const pages = await countPdfPages(bytes)
        if (pages > MAX_PAGES_PER_PART) {
          return await enterSplit(`PDF 共 ${pages} 页，超过 ${MAX_PAGES_PER_PART} 页上限，进入自动拆分`, pages)
        }
      } catch (pageErr) {
        blog('warn', 'pipeline', 'preSplit.pageCountFailed', { message: pageErr instanceof Error ? pageErr.message : String(pageErr) })
      }
    }

    let up: { batchId: string; uploadUrl: string }
    try {
      blog('debug', 'pipeline', 'upload.start', { file: fileName })
      // D-98：按输出多选推导 parse 选项（DOCX / HTML 需服务端生成，必须在请求阶段声明）。
      // 此前传原始 config.mineru.parse，使 effectiveParseOptions 的结果从未进入请求体。
      up = await client.requestUploadUrl({ fileName, parse: effectiveParseOptions(deps) }, signal)
    } catch (err) {
      // 自动拆分仅适用于 PDF（Office/图片无 PDF 切片语义）
      if (isPageLimitError(err) && fileName.toLowerCase().endsWith('.pdf')) {
        return await enterSplit('页数超限（-60006），进入自动拆分分支')
      }
      throw err
    }
    batchId = up.batchId
    await client.uploadFile(up.uploadUrl, bytes, signal)
    log('上传完成，解析任务已自动提交')
    blog('debug', 'pipeline', 'upload.done', { batchId })
    if (persist) {
      await persist.store.recordUpload(persist.taskId, { name: fileName }, batchId, fp, optionsHash)
    }
  }
  if (persist) {
    await persist.store.updateFile(persist.taskId, { name: fileName }, { uploadStatus: 'submitted' })
  }

  // 3) 轮询 → 下载 → 解压（失败回写 upload_status=failed 后抛出，保持原错误语义）
  phase('polling')
  blog('debug', 'pipeline', 'polling.start', { batchId })
  let files: Awaited<ReturnType<typeof safeExtractZip>>
  let outputs: ExtractedOutputs
  let cloudTaskId = ''
  try {
    const status = await client.waitForCompletion(batchId, {
      signal,
      onProgress: (s) => {
        // 官方 v4 state：pending 排队中 / running 正在解析 / converting 格式转换中 / done 完成 / failed 失败
        onEvent({ type: 'progress', extractedPages: s.extractedPages ?? undefined, totalPages: s.totalPages ?? undefined, cloudState: s.state })
        if (s.extractedPages !== null && s.totalPages !== null) {
          log(`解析进度 ${s.extractedPages}/${s.totalPages} 页（状态：${s.state}）`)
        } else {
          log(`云端状态：${s.state}`)
        }
      },
    })
    cloudTaskId = status.taskId
    log(`解析完成（task ${status.taskId}）`)
    blog('debug', 'pipeline', 'polling.done', { cloudTaskId, pages: status.totalPages ?? null })

    phase('downloading')
    throwIfAborted(signal, 'downloading')
    blog('debug', 'pipeline', 'download.start')
    const zipBytes = await client.downloadResultWithFallback(status, () => client.getTaskStatus(status.taskId, signal), signal)
    log(`结果 ZIP 已下载（${(zipBytes.length / 1024).toFixed(1)} KB）`)
    blog('debug', 'pipeline', 'download.done', { kb: Math.round(zipBytes.length / 1024) })

    phase('extracting')
    throwIfAborted(signal, 'extracting')
    blog('debug', 'pipeline', 'extract.start')
    files = safeExtractZip(zipBytes, config.limits)
    outputs = scanOutputs(files)
    const { markdown } = locateOutputs(outputs)
    log(`解包完成：${files.length} 个文件，Markdown = ${markdown}`)
    blog('debug', 'pipeline', 'extract.done', { fileCount: files.length })

    if (persist) {
      await persist.store.updateFile(persist.taskId, { name: fileName }, { uploadStatus: 'completed' })
    }
  } catch (err) {
    if (persist) {
      try {
        await persist.store.updateFile(persist.taskId, { name: fileName }, { uploadStatus: 'failed', status: 'failed' })
      } catch {
        // 回写失败不影响主错误
      }
    }
    throw err
  }

  // 4) 落盘（唯一目录 / 保留名 / 长路径，T1-13）
  blog('debug', 'pipeline', 'write.start', { destDir })
  phase('writing')
  throwIfAborted(signal, 'writing')
  const result = await writeOutputs(fs, files, destDir, stem, { format: effectiveOutputFormat(deps), kinds: effectiveKinds(deps), sameName: deps.sameNameHandling })
  const finalMarkdown = result.markdownPath ?? firstMarkdown(outputs)
  log(`已写入输出目录：${result.outputDir}`)
  // D-43：落库 output_path + markdown_path（供 FileList「打开」直达 full.md）
  if (persist) {
    await persist.store.updateFile(persist.taskId, { name: fileName }, { outputPath: result.outputDir, markdownPath: result.markdownPath ?? null })
  }

  phase('done')
  blog('info', 'pipeline', 'done', { durationMs: Date.now() - startedAt, destDir })
  return {
    outputDir: result.outputDir,
    markdownPath: finalMarkdown,
    batchId,
    taskId: cloudTaskId,
    durationMs: Date.now() - startedAt,
  }
}

/** 供 UI/无头入口判断某错误是否为「非 PDF」类（D-14 提示文案） */
export function isUnsupportedInputError(err: unknown): boolean {
  return isBmuError(err) && err.kind === 'unsupported'
}

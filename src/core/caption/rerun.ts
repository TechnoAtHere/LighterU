// M04 · core/caption/rerun — 单独重跑图片描述（T2-13 / F-24）
// 需求：可对已解析结果单独重跑描述，不重新解析。流程：读 full.md → runCaption →
// 按模式回写（T2-08 替换 / T2-09 两者都有）→ 写前备份 full.md.bak → 覆盖写 full.md。
// 写入失败时 .bak 保留、原文件不变、抛错（调用方可见）。
// 门控：描述开关三层（T2-12）在本层执行——关闭时直接返回空结果，不发任何请求。

import type { AppConfig } from '../types'
import type { FsAdapter } from '../platform/fs'
import { createFsAdapter } from '../platform/fs'
import type { HttpTransport } from '../platform/http'
import { BmuError } from '../client/errors'
import { writebackMarkdown } from '../output/writeback'
import {
  runCaption,
  resolveCaptionEnabled,
} from './run'
import type { CaptionRunFailure, CaptionRunStats } from './run'

export interface RerunCaptionDeps {
  config: AppConfig
  transport: HttpTransport
  fs?: FsAdapter
}

export interface RerunCaptionOptions {
  outputDir: string
  /** 回写模式：'replace' = T2-08 替换原文件（默认）；'both' = T2-09 两者都有（D-36） */
  mode?: 'replace' | 'both'
  concurrency?: number
  customUserPrompt?: string
  /** 入口级默认开关（轮 H：对应设置页「图片描述默认启用」）；仅当 enabledOverride 未给时生效 */
  enabledDefault?: boolean
  /** 调用级开关覆盖（轮 H；优先级最高，对应后续文件/任务级按钮） */
  enabledOverride?: boolean
  signal?: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (done: number, total: number) => void
  timeoutMs?: number
  maxAttempts?: number
  imageUrlForm?: 'data-uri' | 'raw-base64'
}

export interface RerunCaptionResult {
  captions: Map<string, string>
  failures: CaptionRunFailure[]
  stats: CaptionRunStats
  /** 实际发生写回的文件路径列表（无变化/被跳过时为空） */
  written: string[]
  /** 因开关关闭而未执行的原因（仅在跳过时非空） */
  skipped: string | null
}

/**
 * 单独重跑（T2-13 验收：full.md 内容变化、.bak 存在、原文件被覆盖；
 * 写入失败时 .bak 保留、原文件不变、抛错）。
 */
export async function rerunCaption(deps: RerunCaptionDeps, opts: RerunCaptionOptions): Promise<RerunCaptionResult> {
  const fs = deps.fs ?? createFsAdapter()
  const onLog = opts.onLog ?? (() => undefined)
  const { config } = deps
  const mode = opts.mode ?? 'replace'

  // 入口即已取消：直接返回，不读文件、不扫图、不发请求（按钮点击取消的常见情形）
  if (opts.signal?.aborted) {
    onLog('图片描述已取消。')
    return {
      captions: new Map(),
      failures: [],
      stats: { images: 0, described: 0, duplicates: 0, failed: 0, capped: 0 },
      written: [],
      skipped: '已取消',
    }
  }

  // 开关门控（轮 H：调用级 > 入口级默认；enabledDefault 对应设置页「图片描述默认启用」）
  const enabled = resolveCaptionEnabled(opts.enabledDefault ?? false, opts.enabledOverride)
  if (!enabled) {
    onLog('图片描述未开启（入口默认/调用级开关均为关），跳过重跑。')
    return {
      captions: new Map(),
      failures: [],
      stats: { images: 0, described: 0, duplicates: 0, failed: 0, capped: 0 },
      written: [],
      skipped: '描述开关未开启',
    }
  }

  const rootPosix = opts.outputDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const mdPath = `${rootPosix}/full.md`
  let markdown: string
  try {
    markdown = new TextDecoder('utf-8').decode(await fs.readFileBytes(mdPath))
  } catch (err) {
    throw new BmuError('business', `未找到可回写的 Markdown（${mdPath}）：${err instanceof Error ? err.message : String(err)}`, {
      code: 'NO_MARKDOWN', stage: 'caption-rerun',
    })
  }

  // _content_list.json 仅校验存在性（V0.3 不写 JSON img_caption，D-34；读取为预留）
  const contentListPath = `${rootPosix}/_content_list.json`
  if (await fs.exists(contentListPath)) {
    onLog('检测到 _content_list.json（V0.3 不做 JSON 回写，D-34）。')
  }

  const run = await runCaption({ config, transport: deps.transport, fs }, {
    outputDir: opts.outputDir,
    concurrency: opts.concurrency,
    customUserPrompt: opts.customUserPrompt,
    signal: opts.signal,
    onLog,
    onProgress: opts.onProgress,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    imageUrlForm: opts.imageUrlForm,
  })

  const written: string[] = []
  if (run.captions.size === 0) {
    // D-97：区分「目录里根本没有图片」与「有图但全部失败」——前者通常意味着输出为「仅 Markdown」（图片未落盘）
    const noImages = run.stats.images === 0
    const reason = noImages
      ? '输出目录中没有图片（「仅 Markdown」输出不保留图片）——请将输出格式改为「全部产物」后重新解析'
      : '没有可获得描述的图片（调用均失败或已达上限），未写回'
    onLog(reason)
    return { ...run, written, skipped: noImages ? reason : null }
  }

  // 取消后即使已拿到部分描述也不写回，避免「已取消」却留下半截改动。
  // 现有调用方不传 signal 时此分支永不触发，不影响正常重跑。
  if (opts.signal?.aborted) {
    onLog('图片描述已取消，未写回 Markdown。')
    return { ...run, written, skipped: '已取消' }
  }

  const updated = writebackMarkdown(markdown, run.captions, mode)
  if (updated === markdown) {
    onLog('Markdown 内容无变化（无命中引用或已是目标形态），未写回。')
    return { ...run, written, skipped: null }
  }

  // 写前备份（一次性，覆盖已有 .bak）；随后覆盖写。写失败 → .bak 已在、原文件未动
  const backupPath = `${mdPath}.bak`
  await fs.writeFileBytes(backupPath, new TextEncoder().encode(markdown))
  try {
    await fs.writeFileBytes(mdPath, new TextEncoder().encode(updated))
  } catch (err) {
    throw new BmuError('business', `写回 Markdown 失败（原文件未改动，备份在 ${backupPath}）：${err instanceof Error ? err.message : String(err)}`, {
      code: 'WRITEBACK_FAILED', stage: 'caption-rerun',
    })
  }
  written.push(mdPath)
  onLog(`已按「${mode === 'both' ? '两者都有' : '替换原文件'}」模式写回 ${mdPath}（备份：${backupPath}）`)
  return { ...run, written, skipped: null }
}

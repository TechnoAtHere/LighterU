// M04 · core/caption/run — 目录级图片描述入口（T2-07）
// 契约参照 TS-X015（天枢目录入口，去掉回写职责）与 design/02 §3.4：
//   收集图片 → 并发描述 → 返回 Map<image, caption>；**过程不写任何文件**。
// 边界规则（plan/01 §五 规则 2）：caption 不写文件；回写由 core/output 执行（T2-08/09）。
// 描述对象为解析产出的图片，与输入格式（仅 PDF，D-14）无关——任何入口的产物目录均可重跑（F-24）。
// MIT License — 结构改编自 mineru-tianshu（Apache 2.0，保留版权声明）；按 D-07 以 TS 重写。

import type { AppConfig } from '../types'
import type { DirEntry, FsAdapter } from '../platform/fs'
import { createFsAdapter } from '../platform/fs'
import type { HttpTransport } from '../platform/http'
import type { ImageUrlForm } from '../client/multimodal'
import { MultimodalClient } from '../client/multimodal'
import { BmuError } from '../client/errors'
import { resolvePrompt } from './prompts'
import { normalizeDescription } from './normalize'
import { fingerprint } from './fingerprint'
import { runPool } from './batch'
import { log } from '../platform/logger'

/** 参与描述的图片扩展名（与 multimodal.ts MIME 表同集，TS-X003） */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'])

/** 递归扫图深度上限（防符号链接/异常深目录） */
const MAX_SCAN_DEPTH = 6

export interface CaptionRunDeps {
  config: AppConfig
  transport: HttpTransport
  /** 缺省 createFsAdapter()（Tauri/Node 自动选型） */
  fs?: FsAdapter
}

export interface CaptionRunOptions {
  /** 解析输出目录（含 images/ 子目录的产物根） */
  outputDir: string
  /** 覆盖配置并发数（默认 config.multimodal.concurrency，T2-03） */
  concurrency?: number
  /** 自定义 USER 段 Prompt（语义同 T2-02 resolvePrompt；空/空白回落默认） */
  customUserPrompt?: string
  /** 调用级描述开关覆盖（T2-12）：本函数**不拦截**，仅供调用层门控判断（保持纯函数性） */
  enabledOverride?: boolean
  signal?: AbortSignal
  onLog?: (message: string) => void
  onProgress?: (done: number, total: number) => void
  /** 多模态客户端参数覆盖（默认取 config.multimodal.*，见 multimodal.ts 构造） */
  timeoutMs?: number
  maxAttempts?: number
  imageUrlForm?: ImageUrlForm
}

export interface CaptionRunStats {
  /** 扫到的图片文件总数（含重复图与被上限跳过的图） */
  images: number
  /** 实际发起调用且成功的唯一种类数（按指纹去重后） */
  described: number
  /** 因内容指纹重复而跳过调用的图片数 */
  duplicates: number
  /** 失败数（预扫读取失败 + 去重代表调用失败；D-35：重复图共享代表成败，代表失败记 1） */
  failed: number
  /** 因调用上限（config.multimodal.maxImages）跳过的图片数 */
  capped: number
}

/** 失败项（D-35：代表失败时 affectedPaths 列出同指纹组全部路径） */
export interface CaptionRunFailure {
  path: string
  error: string
  affectedPaths: string[]
}

export interface CaptionRunResult {
  /** 图片路径 → 归一后描述（重复图共享同一条目） */
  captions: Map<string, string>
  failures: CaptionRunFailure[]
  stats: CaptionRunStats
}

/**
 * 描述开关解析（轮 H）：调用级（文件/任务级覆盖） > 入口级默认（captionEnabled）。
 * 门控由调用层执行（rerunCaption / App.vue）；runCaption 本身不拦截。
 * 入参 entry 为该入口在设置页配置的「图片描述默认启用」；call 为后续文件/任务级覆盖（未提供则回落入口默认）。
 */
export function resolveCaptionEnabled(
  entry: boolean,
  call?: boolean,
): boolean {
  if (typeof call === 'boolean') return call
  return entry
}

function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase())
}

function basenameOf(path: string): string {
  return path.replace(/^.*[\\/]/, '')
}

/** 递归收集图片路径（深度受限；根目录读取失败抛业务错误，子目录失败仅记日志）。
 *  输出统一为正斜杠路径（与 write.ts 的 toPosix 口径一致，便于 T2-08/09 按 Markdown 相对引用匹配）。 */
async function collectImages(fs: FsAdapter, root: string, onLog: (m: string) => void): Promise<string[]> {
  const out: string[] = []
  const rootPosix = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const walk = async (dir: string, depth: number, isRoot: boolean): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return
    let entries: DirEntry[]
    try {
      entries = await fs.readDir(dir)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isRoot) {
        throw new BmuError('business', `读取输出目录失败：${dir} — ${message}`, { code: 'READ_OUTPUT_DIR', stage: 'caption-run' })
      }
      onLog(`跳过不可读子目录：${dir} — ${message}`)
      return
    }
    for (const entry of entries) {
      const full = `${dir.replace(/[\\/]+$/, '')}/${entry.name}`
      if (entry.isDir) await walk(full, depth + 1, false)
      else if (isImageName(entry.name)) out.push(full)
    }
  }
  await walk(rootPosix, 0, true)
  return out.sort()
}

/**
 * 目录级图片描述（T2-07 验收：对解析输出目录返回 Map<image,caption>；过程不修改任何文件）。
 * 流程：递归扫图 → 预扫指纹分组（读完即释，控内存）→ 调用上限截断（T2-10 maxImages）→
 *       去重代表进并发池 → 归一描述 → 扇出到同指纹全部路径。单张失败不阻断其余（TS-X010~012 / R6）；
 *       代表失败时 affectedPaths 列出同指纹组全部路径（D-35），stats.failed 仍记 1。
 */
export async function runCaption(deps: CaptionRunDeps, opts: CaptionRunOptions): Promise<CaptionRunResult> {
  const fs = deps.fs ?? createFsAdapter()
  const onLog = opts.onLog ?? (() => undefined)
  const { config } = deps

  log('info', 'caption', 'run.enter', { outputDir: opts.outputDir, hasImageUrlForm: Boolean(opts.imageUrlForm) })
  const imagePaths = await collectImages(fs, opts.outputDir, onLog)

  // 预扫：内容指纹分组（同字节 = 同描述；读完即释，控制常驻内存）
  const groups = new Map<string, string[]>()
  const failures: CaptionRunFailure[] = []
  for (const path of imagePaths) {
    try {
      const bytes = await fs.readFileBytes(path)
      const fp = fingerprint(bytes)
      const group = groups.get(fp)
      if (group) group.push(path)
      else groups.set(fp, [path])
    } catch (err) {
      failures.push({ path, error: err instanceof Error ? err.message : String(err), affectedPaths: [path] })
    }
  }

  // 去重代表（每组第一个；sorted 保证确定性）
  const representatives: Array<{ fp: string; path: string }> = []
  for (const [fp, paths] of groups) representatives.push({ fp, path: paths[0] })

  // 调用上限（T2-10：maxImages > 0 时截断；0 = 不限）
  const maxImages = config.multimodal.maxImages ?? 0
  let cappedImages = 0
  let limited = representatives
  if (maxImages > 0 && representatives.length > maxImages) {
    limited = representatives.slice(0, maxImages)
    cappedImages = representatives.slice(maxImages).reduce((sum, r) => sum + (groups.get(r.fp)?.length ?? 0), 0)
    onLog(`已达图片描述调用上限（${maxImages} 个种类），跳过 ${cappedImages} 张图片（含重复图）`)
  }

  const client = new MultimodalClient({
    config,
    transport: deps.transport,
    onLog,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    imageUrlForm: opts.imageUrlForm,
  })
  const prompt = resolvePrompt(opts.customUserPrompt)
  const concurrency = opts.concurrency ?? config.multimodal.concurrency ?? 4
  const maxDescriptionChars = config.multimodal.maxDescriptionChars

  const pool = await runPool(
    limited.map((r) => r.path),
    async (path) => {
      const bytes = await fs.readFileBytes(path)
      const result = await client.caption(
        { image: bytes, fileName: basenameOf(path), prompt: prompt.user, systemPrompt: prompt.system },
        opts.signal,
      )
      return normalizeDescription(result.text, maxDescriptionChars)
    },
    {
      concurrency,
      signal: opts.signal,
      onProgress: opts.onProgress,
      onFailure: (path, error) => onLog(`图片描述失败：${path} — ${error}`),
    },
  )

  // D-35：代表失败展开同指纹组全部路径（stats.failed 仍按代表计 1）
  const groupOfPath = new Map<string, string[]>()
  for (const paths of groups.values()) {
    for (const p of paths) groupOfPath.set(p, paths)
  }
  for (const failure of pool.failures) {
    const affected = groupOfPath.get(failure.path) ?? [failure.path]
    failures.push({ ...failure, affectedPaths: affected })
    for (const p of affected) {
      if (p !== failure.path) onLog(`  受影响（同内容）：${p}`)
    }
  }

  // 扇出：同指纹组成员共享代表条目的描述（被上限跳过的组无描述）
  const captions = new Map<string, string>()
  let duplicates = 0
  for (const paths of groups.values()) {
    const representative = paths[0]
    const caption = pool.values.get(representative)
    for (const path of paths) {
      if (path !== representative) duplicates += 1
      if (caption !== undefined) captions.set(path, caption)
    }
  }

  log('info', 'caption', 'run.done', { images: imagePaths.length, described: pool.values.size, failed: failures.length, capped: cappedImages })
  return {
    captions,
    failures,
    stats: {
      images: imagePaths.length,
      described: pool.values.size,
      duplicates,
      failed: failures.length,
      capped: cappedImages,
    },
  }
}

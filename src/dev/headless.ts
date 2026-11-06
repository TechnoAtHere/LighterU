// dev-only · 无头入口核心（D-24）
// 调用与壳 UI 完全相同的 src/core（TaskManager → pipeline → client），不新增逻辑；
// 环境差异由 platform 适配层吸收（Tauri 内走 Rust 命令，Node 内走 node:fs/fetch）。
// 本模块同时被 headless-cli（Node 直跑）与 main.ts 的 ?headless=1 开发分支（WebView 内跑）复用。
// T2-15：caption 系列参数为联调期注入（GUI 多模态配置入口属 T5-07，dev-only 不进生产）。

import { TaskManager } from '../core/tasks'
import { loadConfig, applyEnvOverrides } from '../core/config'
import { createConfigStore } from '../core/platform/store'
import { createSecretsAdapter } from '../core/platform/secrets'
import { createHttpTransport } from '../core/platform/http'
import { rerunCaption } from '../core/caption'
import type { HttpTransportKind, JobStatus } from '../core/types'

export interface HeadlessOptions {
  filePath: string
  outputDir?: string
  baseUrl?: string
  token?: string
  transport?: HttpTransportKind
  entry?: 'workbench' | 'context-menu'
  log?: (line: string) => void
  /** T2-15 联调：图片描述开关（注入 入口 captionEnabled） */
  caption?: boolean
  /** 多模态 base_url（注入 multimodal.baseUrl） */
  captionBase?: string
  /** 多模态 API Key（仅内存注入，不持久化——同 mineru token 口径） */
  captionKey?: string
  /** 多模态模型名 */
  captionModel?: string
  /** 回写模式：replace = T2-08（默认）；both = T2-09 */
  captionMode?: 'replace' | 'both'
}

export interface HeadlessResult {
  jobId: string
  status: JobStatus
  outputDir: string | null
  error: string | null
  errorKind: string | null
  durationMs: number
}

/** 把 caption 系列参数注入配置（联调期专用；密钥仅内存，不落盘） */
function applyCaptionOptions(config: HeadlessConfig, opts: HeadlessOptions): void {
  if (opts.caption !== undefined) {
    config.output.rightClick.captionEnabled = opts.caption
    config.output.workbench.captionEnabled = opts.caption
  }
  if (opts.captionBase !== undefined && opts.captionBase.trim() !== '') {
    config.multimodal.baseUrl = opts.captionBase.trim().replace(/\/+$/, '')
  }
  if (opts.captionKey !== undefined) config.multimodal.apiKey = opts.captionKey
  if (opts.captionModel !== undefined) config.multimodal.model = opts.captionModel.trim()
}

type HeadlessConfig = Awaited<ReturnType<typeof loadConfig>>

/**
 * 跑一个 PDF 的完整解析链。返回终态（done/failed/canceled），不抛业务错误——
 * 调用方按 status/errorKind 判断。
 * 若开启 caption 且解析成功：解析后自动执行 rerunCaption（T2-13 同链路）完成描述与回写。
 */
export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const startedAt = Date.now()

  let config = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() })
  config = applyEnvOverrides(config)
  if (opts.baseUrl !== undefined && opts.baseUrl.trim() !== '') {
    config.mineru.baseUrl = opts.baseUrl.trim().replace(/\/+$/, '')
  }
  if (opts.token !== undefined) config.mineru.token = opts.token
  if (opts.outputDir !== undefined) config.output.outputDir = opts.outputDir
  if (opts.transport !== undefined) config.http.transport = opts.transport
  if (opts.entry !== undefined) config.output.entry = opts.entry
  applyCaptionOptions(config, opts)

  const manager = new TaskManager(config)
  manager.subscribe(({ event }) => {
    if (event.type === 'log' && event.message) log(event.message)
  })

  const job = manager.createJob(opts.filePath)
  const finalJob = await manager.runJob(job.id)

  // T2-15（轮 H）：解析成功后按开关判定执行描述 + 回写（与 GUI 的 T2-13 链路同函数）
  if (finalJob.status === 'done' && finalJob.outputDir) {
    try {
      const rerun = await rerunCaption(
        { config, transport: createHttpTransport(config.http.transport) },
        {
          outputDir: finalJob.outputDir,
          mode: opts.captionMode ?? 'replace',
          enabledDefault: config.output[config.output.entry === 'context-menu' ? 'rightClick' : 'workbench'].captionEnabled,
          enabledOverride: true,
          onLog: log,
        },
      )
      log(`图片描述完成：${rerun.stats.described} 个种类（${rerun.stats.images} 张图，去重 ${rerun.stats.duplicates}，上限跳过 ${rerun.stats.capped}，失败 ${rerun.stats.failed}）`)
      if (rerun.written.length > 0) log(`已写回：${rerun.written.join(', ')}`)
    } catch (err) {
      log(`图片描述阶段失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    jobId: job.id,
    status: finalJob.status,
    outputDir: finalJob.outputDir,
    error: finalJob.error,
    errorKind: finalJob.errorKind,
    durationMs: Date.now() - startedAt,
  }
}

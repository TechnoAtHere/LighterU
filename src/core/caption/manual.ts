// 行内「图片解析」共用执行器（工作站 / 进度窗复用）。
// 只负责对某个已产出目录重跑图片描述；UI 状态（蓝/绿）由 FileList 维护。
import { rerunCaption } from './rerun'
import { resolveActivePromptContent } from './prompts'
import { createHttpTransport } from '../platform/http'
import { createFsAdapter } from '../platform/fs'
import type { AppConfig, Job } from '../types'

export interface JobCaptionOutcome {
  /** 是否可视为成功（未跳过且无失败图） */
  ok: boolean
  /** 因开关关闭等原因跳过时的原因 */
  skipped: string | null
  described: number
  failed: number
  error?: string
}

/** 多模态服务是否已配置（地址与密钥均非空） */
export function hasMultimodalConfig(cfg: AppConfig): boolean {
  return Boolean(cfg.multimodal.baseUrl?.trim() && cfg.multimodal.apiKey?.trim())
}

/** 对单个文件的输出目录重跑图片描述（使用当前选中的提示词方案与入口写入模式）。 */
export async function runJobCaption(
  cfg: AppConfig,
  job: Job,
  onLog?: (message: string) => void,
): Promise<JobCaptionOutcome> {
  if (!job.outputDir) {
    return { ok: false, skipped: null, described: 0, failed: 0, error: '该文件尚无输出目录' }
  }
  const entry = cfg.output.entry === 'context-menu' ? cfg.output.rightClick : cfg.output.workbench
  const result = await rerunCaption(
    { config: cfg, transport: createHttpTransport(cfg.http.transport), fs: createFsAdapter() },
    {
      outputDir: job.outputDir,
      mode: entry.captionMode,
      enabledDefault: true,
      enabledOverride: true,
      customUserPrompt: resolveActivePromptContent(cfg.multimodal),
      onLog,
    },
  )
  return {
    ok: result.skipped == null && result.stats.failed === 0,
    skipped: result.skipped,
    described: result.stats.described,
    failed: result.stats.failed,
  }
}

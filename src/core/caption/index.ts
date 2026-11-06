// M04 · core/caption 桶文件
// T2-02：双段 Prompt；T2-03：并发池；T2-05：输出归一；T2-06：内容指纹；T2-07：目录级入口。
// 边界规则（plan/01 §五）：caption 不写文件，只返回描述映射；回写由 core/output（T2-08/09）执行。

export { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT, resolvePrompt } from './prompts'
export {
  DEFAULT_PROMPT_PRESETS,
  USER_PROMPT_PREFIX,
  isUserPromptId,
  newUserPromptId,
  normalizeCustomPrompts,
  listPromptPresets,
  resolveActivePromptPreset,
  resolveActivePromptContent,
} from './prompts'
export type { ResolvedPrompt, PromptSettingsLike } from './prompts'
export type { PromptPreset } from '../types'
export { fingerprint } from './fingerprint'
export { normalizeDescription, MAX_DESCRIPTION_CHARS } from './normalize'
export { runPool, DEFAULT_CONCURRENCY } from './batch'
export type { BatchFailure, BatchOptions, BatchResult } from './batch'
export { runCaption, resolveCaptionEnabled } from './run'
export type { CaptionRunDeps, CaptionRunOptions, CaptionRunResult, CaptionRunFailure, CaptionRunStats } from './run'
export { rerunCaption } from './rerun'
export type { RerunCaptionDeps, RerunCaptionOptions, RerunCaptionResult } from './rerun'

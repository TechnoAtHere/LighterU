// M02 · core/client 桶文件
// 边界规则（plan/01 §五）：UI 不直接调 client；client 重试参数来自 config；轮询循环在 pipeline/client 内，
// 不放在前端（MB-X090/091 教训）。

export { MinerUCloudClient } from './mineru-cloud'
export type { MinerUCloudClientOptions } from './mineru-cloud'
export {
  MultimodalClient,
  buildChatPayload,
  cleanCaption,
  mimeOf,
  parseCaptionResponse,
  toBase64,
} from './multimodal'
export type {
  CaptionRequest,
  CaptionResult,
  CaptionUsage,
  ImageUrlForm,
  MultimodalClientOptions,
} from './multimodal'
export {
  BmuError,
  classifyHttpFailure,
  classifyNetworkFailure,
  classifyUnknownFailure,
  CODE_HINTS,
  isAuthCode,
  isBmuError,
  isLimitCode,
} from './errors'
export { cloudBackoffSeconds, withRetry, defaultShouldRetry } from './retry'
export { maskSecret, maskSecretsInText } from './logmask'
export { RESPONSE_FIELD_NAMES, findFirst, normalizeState, parseTaskStatus } from './compat'

// M02 · core/client/compat — 字段名兼容层 + state 归一（T1-10）
// 候选字段表照搬 OT-X095/096/110/111（client.py:437-446 parse_task_status 默认值）：
// 换字段名只改这里的候选列表，不改调用代码。
// MIT License — 改编自 MinerU-OCR-Tool（src/mineru_ocr_tool/client.py:437-483，
// 许可证经 D-29 用户确认为 MIT；保留原始版权声明与 LICENSE）。

import type { CloudState, TaskStatus } from '../types'

/** 候选字段名表：命中任一即归一（T1-10 验收） */
export const RESPONSE_FIELD_NAMES: Record<string, string[]> = {
  state: ['state', 'status'],
  message: ['err_msg', 'error', 'message', 'msg'],
  resultUrl: ['full_zip_url', 'zip_url', 'result_url', 'download_url'],
  markdownUrl: ['markdown_url', 'md_url'],
  progress: ['extract_progress', 'progress'],
  progressDone: ['extracted_pages', 'current', 'done'],
  progressTotal: ['total_pages', 'total'],
  taskId: ['task_id', 'extract_id', 'id'],
  batchId: ['batch_id'],
}

/** 按候选列表取第一个存在的字段（OT-X _find_first 语义） */
export function findFirst(payload: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = payload[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

const STATE_ALIASES: Record<string, CloudState> = {
  succeeded: 'done',
  success: 'done',
  completed: 'done',
  complete: 'done',
  finish: 'done',
  finished: 'done',
  failure: 'failed',
  error: 'failed',
  running: 'running',
  pending: 'pending',
  queued: 'pending',
  converting: 'running',
  uploading: 'running',
  'waiting-file': 'pending',
  done: 'done',
  failed: 'failed',
}

/** state 别名归一（OT-X normalize_state 语义；plan/04 P-1 state 全集 + 兜底 unknown） */
export function normalizeState(raw: string): CloudState {
  const value = raw.trim().toLowerCase()
  return STATE_ALIASES[value] ?? 'unknown'
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 解析单个任务/批次结果项 → TaskStatus。
 * 传入的是 extract_result 的**单项**而非整个信封（OT-X 实证：信封顶层 msg 会遮蔽单项 err_msg）。
 */
export function parseTaskStatus(taskId: string, batchId: string, payload: Record<string, unknown>): TaskStatus {
  const fields = RESPONSE_FIELD_NAMES
  const rawState = findFirst(payload, fields.state)
  const message = findFirst(payload, fields.message)
  const resultUrl = findFirst(payload, fields.resultUrl)
  const markdownUrl = findFirst(payload, fields.markdownUrl)
  const extractedPages = findFirst(payload, fields.progressDone)
  const totalPages = findFirst(payload, fields.progressTotal)
  const resolvedTaskId = findFirst(payload, fields.taskId)

  return {
    taskId: String(resolvedTaskId ?? taskId),
    batchId,
    state: normalizeState(String(rawState ?? 'unknown')),
    message: typeof message === 'string' ? message : '',
    resultUrl: typeof resultUrl === 'string' && resultUrl !== '' ? resultUrl : null,
    markdownUrl: typeof markdownUrl === 'string' && markdownUrl !== '' ? markdownUrl : null,
    extractedPages: toNumberOrNull(extractedPages),
    totalPages: toNumberOrNull(totalPages),
    raw: payload,
  }
}

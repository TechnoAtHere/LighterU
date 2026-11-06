// core/tasks/resume — 断点续传判定（T3-08）
// 决策：文件指纹 + 选项哈希一致、且已有上传 data_id、且未失败 → 可复用旧 entry（不重传/不重提）。
// 选项或文件变化时不复用旧 entry（需求终版：重选 PDF 或改选项应重新解析）。

/** 续传候选（通常来自 task_files 已落库记录） */
export interface ResumeCandidate {
  fingerprint: string
  optionsHash: string
  dataId: string | null
  status: string
}

/** 当前提交上下文 */
export interface ResumeCurrent {
  fingerprint: string
  optionsHash: string
}

/**
 * 是否可复用旧 entry（断点续传）：
 * - 指纹一致（同一文件）
 * - 选项哈希一致（未改解析选项/输出位置等）
 * - 已拿到服务端 data_id（上传成功过）
 * - 旧条目未失败（failed 必须重来）
 */
export function isResumeCompatible(stored: ResumeCandidate, current: ResumeCurrent): boolean {
  if (!stored.dataId) return false
  if (stored.status === 'failed') return false
  if (stored.fingerprint !== current.fingerprint) return false
  if (stored.optionsHash !== current.optionsHash) return false
  return true
}

/** 由解析选项 + 入口算出选项哈希（稳定字符串即可，用于"选项变化不复用"判定） */
export function hashOptions(opts: Record<string, unknown>): string {
  const keys = Object.keys(opts).sort()
  const parts = keys.map((k) => `${k}=${JSON.stringify(opts[k])}`)
  return parts.join('&')
}

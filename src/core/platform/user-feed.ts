// core/platform · 用户通知流（轮 G 日志重构 / T2·T5）
// 设计（见 plan/06 D-72）：内存单例，仅存在于当前 webview；主窗口关闭即销毁（不落盘、不持久化）。
// 与调试日志（logger 黑盒）分离：这里是「用户需要知道/需要操作」的通知，非技术细节。
// 能力：追加(push)、原地更新(upsert by id，用于「进程更新原地替换、最后汇总」)、清空、未读计数、订阅。

import type { UserMessage } from './user-messages'

export interface FeedEntry extends UserMessage {
  /** 稳定 id：提供则同名去重并原地更新（进程更新）；不提供则自动生成 */
  id: string
  at: number
  read: boolean
}

let seq = 0
const entries: FeedEntry[] = []
const bus = new EventTarget()
/** 内存上限：长时间运行防止无限增长（旧条目自动淘汰） */
const MAX_ENTRIES = 200

function emit(): void {
  try {
    bus.dispatchEvent(new CustomEvent('change'))
  } catch {
    // 旁路事件，忽略异常
  }
}

export interface PushOptions {
  /** 显式 id：提供则同名去重/原地覆盖（用于进度更新 → 最终汇总） */
  id?: string
}

/** 追加或原地更新一条用户通知；返回最终 entry id（供后续 upsert）。 */
export function pushUserMessage(msg: UserMessage, opts?: PushOptions): string {
  const id = opts?.id ?? `u${Date.now().toString(36)}_${seq++}`
  const existing = opts?.id ? entries.find((e) => e.id === opts.id) : undefined
  if (existing) {
    existing.code = msg.code
    existing.level = msg.level
    existing.title = msg.title
    existing.detail = msg.detail
    existing.action = msg.action
    existing.debugHint = msg.debugHint
  } else {
    entries.push({ ...msg, id, at: Date.now(), read: false })
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  }
  emit()
  return id
}

/** 按 id 原地更新部分字段（用于进度推进中的标题/详情变更）。 */
export function upsertUserMessage(id: string, patch: Partial<UserMessage>): void {
  const e = entries.find((x) => x.id === id)
  if (!e) return
  Object.assign(e, patch)
  emit()
}

/**
 * 终态收口（轮 H · 过程/结果模型）：按 id 原地替换「结果」字段（code/level/title/action/debugHint），
 * 并把传入的 detail 作为最后一行追加到已有 detail —— 这样「详细」模式能看到完整过程 + 结果，
 * 「简略」模式只看 title（结果）。用于 split/batch/retry 这类「过程更新原地替换、结束汇总」的消息。
 */
export function concludeUserMessage(id: string, msg: UserMessage): void {
  const e = entries.find((x) => x.id === id)
  if (!e) return
  e.code = msg.code
  e.level = msg.level
  e.title = msg.title
  e.action = msg.action
  e.debugHint = msg.debugHint
  e.detail = e.detail ? `${e.detail}\n${msg.detail ?? ""}` : msg.detail
  emit()
}

/** 清空通知（用户点击「清空」）。 */
export function clearUserFeed(): void {
  entries.length = 0
  emit()
}

/** 当前快照（倒序：最新在前）。 */
export function getUserFeed(): FeedEntry[] {
  return entries.slice().reverse()
}

/** 未读数量。 */
export function unreadCount(): number {
  let n = 0
  for (const e of entries) if (!e.read) n++
  return n
}

/** 全部标记为已读（面板展开/聚焦时调用）。 */
export function markAllRead(): void {
  let changed = false
  for (const e of entries) {
    if (!e.read) {
      e.read = true
      changed = true
    }
  }
  if (changed) emit()
}

/** 订阅变更（新增/更新/清空/已读）；返回取消函数。 */
export function onUserFeed(handler: () => void): () => void {
  const wrapped = (): void => handler()
  bus.addEventListener('change', wrapped)
  return () => bus.removeEventListener('change', wrapped)
}

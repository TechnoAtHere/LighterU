// platform · 事件推送（T4-08）：跨窗口经 Tauri event；非 Tauri（selftest/headless/浏览器 dev）降级为进程内 EventTarget。
// 命名规范（D-40）：统一前缀 `lu:`，三类事件 task-status / task-progress / log-line。
// 约束：payload 经 scrubSecrets 脱敏；发送失败 try/catch 包裹不阻断主流程；订阅返回取消函数。

import { isTauri } from './env'
import { scrubSecrets } from '../client/logmask'
import type { JobStatus } from '../types'

/** D-40 事件名规范 */
export const LU_EVENTS = {
  status: 'lu:task-status',
  progress: 'lu:task-progress',
  log: 'lu:log-line',
  history: 'lu:history-changed',
  cli: 'lu:cli-command',
} as const

export interface TaskStatusPayload {
  taskId: string
  fileId?: string
  state: JobStatus
  error?: string
  stage?: string
}

export interface TaskProgressPayload {
  taskId: string
  fileId?: string
  elapsedMs: number
  partIndex?: number
  partTotal?: number
}

export interface LogLinePayload {
  taskId?: string
  level: 'info' | 'warn' | 'error'
  message: string
  timestamp: number
}

// ---- 非 Tauri 降级：进程内 EventTarget ----
const bus = new EventTarget()
const localEmit = (name: string, detail: unknown): void => {
  bus.dispatchEvent(new CustomEvent(name, { detail }))
}
const localOn = (name: string, handler: (detail: unknown) => void): (() => void) => {
  const wrapped = (e: Event): void => handler((e as CustomEvent).detail)
  bus.addEventListener(name, wrapped)
  return () => bus.removeEventListener(name, wrapped)
}

/** 发送失败不阻断主流程 */
function safeFire(fn: () => void): void {
  try {
    fn()
  } catch {
    // 忽略：事件是旁路，不影响解析主流程
  }
}

function tauriEmit(name: string, payload: unknown): void {
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit(name, payload))
    .catch(() => undefined)
}

export function emitTaskStatus(p: TaskStatusPayload): void {
  const masked: TaskStatusPayload = { ...p, error: p.error ? scrubSecrets(p.error) : undefined }
  safeFire(() => (isTauri() ? tauriEmit(LU_EVENTS.status, masked) : localEmit(LU_EVENTS.status, masked)))
}

export function emitTaskProgress(p: TaskProgressPayload): void {
  safeFire(() => (isTauri() ? tauriEmit(LU_EVENTS.progress, p) : localEmit(LU_EVENTS.progress, p)))
}

export function emitLogLine(p: LogLinePayload): void {
  const masked: LogLinePayload = { ...p, message: scrubSecrets(p.message) }
  safeFire(() => (isTauri() ? tauriEmit(LU_EVENTS.log, masked) : localEmit(LU_EVENTS.log, masked)))
}

/** D-45：历史变更广播（落库后发），其他窗口收到即刷新历史列表 */
export function emitHistoryChanged(taskId?: string): void {
  safeFire(() => (isTauri() ? tauriEmit(LU_EVENTS.history, { taskId }) : localEmit(LU_EVENTS.history, { taskId })))
}

function subscribe<T>(name: string, handler: (payload: T) => void): () => void {
  if (isTauri()) {
    let un: (() => void) | null = null
    let cancelled = false
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<T>(name, (e) => handler(e.payload)))
      .then((u) => {
        un = u
        if (cancelled) u()
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      un?.()
    }
  }
  return localOn(name, (detail) => handler(detail as T))
}

export function onTaskStatus(handler: (p: TaskStatusPayload) => void): () => void {
  return subscribe<TaskStatusPayload>(LU_EVENTS.status, handler)
}

export function onTaskProgress(handler: (p: TaskProgressPayload) => void): () => void {
  return subscribe<TaskProgressPayload>(LU_EVENTS.progress, handler)
}

export function onLogLine(handler: (p: LogLinePayload) => void): () => void {
  return subscribe<LogLinePayload>(LU_EVENTS.log, handler)
}

export function onHistoryChanged(handler: (taskId?: string) => void): () => void {
  return subscribe<{ taskId?: string }>(LU_EVENTS.history, (p) => handler(p?.taskId))
}

/** T4-07/右键：Rust 侧 lu:cli-command。方案 A 下 parse 的 file_paths 为聚合后的整批文件。 */
export interface CliCommandPayload {
  action: string;
  /** parse：Rust 侧聚合后的整批文件路径；其余动作为 null */
  file_paths?: string[] | null;
}

/**
 * `onReady` 在 Tauri `listen` 真正注册成功后触发。
 * 方案 A 依赖它通知 Rust 标记 frontend_ready：flusher 必须等订阅建立后才下发批次，
 * 否则冷启动时（main 隐藏、配置/DB 初始化较慢）整批 parse 事件会在订阅前 emit 而丢失。
 */
export function onCliCommand(handler: (p: CliCommandPayload) => void, onReady?: () => void): () => void {
  if (!isTauri()) {
    const off = localOn(LU_EVENTS.cli, (detail) => handler(detail as CliCommandPayload))
    onReady?.()
    return off
  }
  let un: (() => void) | null = null
  let cancelled = false
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<CliCommandPayload>(LU_EVENTS.cli, (e) => handler(e.payload)))
    .then((u) => {
      un = u
      if (cancelled) {
        u()
        return
      }
      onReady?.()
    })
    .catch(() => onReady?.()) // 订阅失败也放行，Rust 侧另有 10s 就绪兜底
  return () => {
    cancelled = true
    un?.()
  }
}

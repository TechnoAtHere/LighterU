// platform · 统一链路日志（D.11 全链路日志追踪）
// 设计：单号 JSON 格式；分级 trace/debug/info/warn/error；trace 仅 dev、debug 可关闭、info/warn/error 恒记录；
// 脱敏复用 client/logmask 的 maskSecret/scrubSecrets；内存环形缓冲 + 非阻塞异步落盘，不阻塞主流程；
// 不引入新依赖。仅添加日志调用，不改任何业务逻辑。
// 说明（轮 I）：info/warn/error 始终记录（含生产，保留关键链路）；
//       debug/trace 在 dev 始终可见，生产仅当 debugEnabled=true 时记录（开启即「全量」）。

import { isTauri } from './env'
import { isDev } from './env'
import { maskSecret, scrubSecrets } from '../client/logmask'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  level: LogLevel
  module: string
  event: string
  taskId?: string
  data?: Record<string, unknown>
}

export interface LogOptions {
  taskId?: string
  data?: Record<string, unknown>
}

const BUFFER_CAP = 2000
const buffer: LogEntry[] = []
// 轮 I 日志增强：info/warn/error 始终落盘（含生产）；debug/trace 受 debugEnabled 控制（dev 恒开）。
// 默认开启调试（越详细越好），容量上限 50MB 滚动清理，避免单文件无限增长。
let debugEnabled = false
/** 调试日志目录总容量上限（MB）；超限滚动删除最旧文件 */
let maxSizeMB = 50
let started = false

// 非阻塞落盘状态
let fileDir: string | null = null
let fileBase: string | null = null
let pending: LogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** 目录容量巡检节流：不必每 250ms 的 flush 都 readDir+stat 一遍 */
let lastCapCheck = 0
const CAP_CHECK_INTERVAL_MS = 60_000
/** 当前文件体积检查节流：5s 一次足够，避免高频 stat */
let lastSizeCheck = 0
const SIZE_CHECK_INTERVAL_MS = 5_000

function nowIso(): string {
  return new Date().toISOString()
}

/** 脱敏后的单行 JSON（先逐顶层密钥字段 mask，再对整行 scrub 兜底） */
function jsonLine(e: LogEntry): string {
  const obj: Record<string, unknown> = {
    ts: e.ts,
    level: e.level,
    module: e.module,
    event: e.event,
  }
  if (e.taskId) obj.taskId = e.taskId
  if (e.data) {
    const masked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e.data)) {
      if (typeof v === 'string' && /token|api[_-]?key|secret|password/i.test(k)) {
        masked[k] = maskSecret(v)
      } else {
        masked[k] = v
      }
    }
    obj.data = masked
  }
  return scrubSecrets(JSON.stringify(obj))
}

/** 脱敏 URL：去掉查询串（预签名 URL 的签名在 query 中），仅保留 协议://host/path */
export function maskUrl(url: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return url.replace(/[?#].*$/, '')
  }
}

export function setDebugEnabled(on: boolean): void {
  debugEnabled = on
  if (on) void touchLog()
}

export function isDebugEnabled(): boolean {
  return debugEnabled
}

/** 设置调试日志目录容量上限（MB）；由 config.logging.maxSizeMB 或设置页注入。 */
export function setMaxSizeMB(n: number): void {
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) maxSizeMB = Math.min(1024, n)
}

/**
 * 记录一条链路日志。第四参直接传 data 对象（本项目统一用法）；亦可传 { taskId?, data? }。
 * 若 data 内显式含 taskId，自动提升到顶层字段（符合统一格式）。
 */
export function log(level: LogLevel, module: string, event: string, data?: Record<string, unknown>, taskId?: string): void {
  // 分级策略（轮 I）：info/warn/error 始终记录（含生产，保留关键链路）；
  // debug/trace：dev 始终可见，生产仅当 debugEnabled=true 时记录（开启即「全量」）。
  if (level === 'trace' && !isDev() && !debugEnabled) return
  if (level === 'debug' && !debugEnabled && !isDev()) return
  // info / warn / error：始终记录

  // 兼容 { taskId?, data? } 写法，并允许 data 内 taskId 提升到顶层
  let topTaskId = taskId
  let realData = data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const maybeTid = (data as Record<string, unknown>).taskId
    if (typeof maybeTid === 'string' && !topTaskId) topTaskId = maybeTid
  }

  const entry: LogEntry = {
    ts: nowIso(),
    level,
    module,
    event,
    taskId: topTaskId,
    data: realData,
  }

  // 内存环形缓冲（同步、极快）
  buffer.push(entry)
  if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP)

  // 非阻塞落盘（仅 Tauri 且路径已就绪）
  if (fileBase && fileDir && isTauri()) {
    pending.push(entry)
    // 磁盘持续写入失败时避免待写队列无限增长（丢弃最旧，内存有界）
    if (pending.length > BUFFER_CAP) pending.splice(0, pending.length - BUFFER_CAP)
    scheduleFlush()
  }

  // dev 同时打到 console 便于实时观察（不阻塞主流程）
  if (isDev()) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(`[lu:${level}] ${module}.${event}`, realData ?? '')
  }
}

function scheduleFlush(): void {
  if (flushTimer != null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, 250)
}

async function flush(): Promise<void> {
  if (!fileBase || !fileDir) return
  const batch = pending
  pending = []
  if (batch.length === 0) return
  const maxBytes = maxSizeMB * 1024 * 1024
  try {
    const { mkdir, writeTextFile, stat, rename, readDir, remove } = await import('@tauri-apps/plugin-fs')
    await mkdir(fileDir, { recursive: true })
    const path = `${fileDir}/${fileBase}`
    const now = Date.now()
    // 滚动：当前文件已超上限则归档为 .N.log（体积检查节流 5s，避免每次 flush 都 stat）
    let rotated = false
    if (now - lastSizeCheck >= SIZE_CHECK_INTERVAL_MS) {
      lastSizeCheck = now
      try {
        const s = await stat(path)
        if (s.size >= maxBytes) {
          const target = await nextRotateName(fileDir, fileBase)
          await rename(path, target)
          rotated = true
        }
      } catch {
        // 文件不存在（被手动删除/清空）：忽略，下方 writeTextFile 将以 append 重建
      }
    }
    const text = batch.map(jsonLine).join('\n') + '\n'
    try {
      await writeTextFile(path, text, { append: true })
    } catch {
      // 写入失败（如并发删除/权限异常）：本批重新入队，下一次 flush 重试，避免日志丢失
      pending.push(...batch)
      scheduleFlush()
      return
    }
    // 目录总容量：节流巡检（60s 或发生滚动时），避免每次 flush 都 readDir+stat 遍历目录
    if (rotated || now - lastCapCheck >= CAP_CHECK_INTERVAL_MS) {
      lastCapCheck = now
      await enforceDirCap(fileDir, maxBytes, readDir, stat, remove)
    }
  } catch {
    // 目录/依赖异常：本批重新入队，下一次 flush 重试
    pending.push(...batch)
    scheduleFlush()
  }
}

/**
 * 主动确保日志文件存在：被手动删除/清空后立即重建空文件，避免「删除后不再写入」的观感，
 * 也保证后续 append 续写正常。在 initLogger / setDebugEnabled(true) / clearLogs 后调用。
 */
export async function touchLog(): Promise<void> {
  if (!fileBase || !fileDir || !isTauri()) return
  try {
    const { mkdir, exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
    await mkdir(fileDir, { recursive: true })
    const path = `${fileDir}/${fileBase}`
    if (!(await exists(path))) {
      await writeTextFile(path, '', { append: true })
    }
  } catch {
    // 忽略：写失败不影响主流程，下一次日志 flush 会再次尝试创建
  }
}

/** 找到下一个空闲的归档名 lu-YYYY-MM-DD.N.log */
async function nextRotateName(dir: string, base: string): Promise<string> {
  const { readDir } = await import('@tauri-apps/plugin-fs')
  const items = await readDir(dir)
  const names = new Set(items.map((x) => x.name))
  let i = 1
  while (names.has(`${base}.${i}.log`)) i++
  return `${dir}/${base}.${i}.log`
}

/** 目录内 lu-*.log 按名称升序（最旧在前）删除，直到总大小 <= maxBytes */
async function enforceDirCap(
  dir: string,
  maxBytes: number,
  readDir: (p: string) => Promise<Array<{ name: string; isFile?: boolean; isDirectory?: boolean }>>,
  stat: (p: string) => Promise<{ size: number }>,
  remove: (p: string) => Promise<void>,
): Promise<void> {
  const items = await readDir(dir)
  const logs = items
    .filter((it) => it.isFile !== false && it.name.startsWith('lu-') && it.name.endsWith('.log'))
    .map((it) => ({ name: it.name, size: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))
  let total = 0
  for (const it of logs) {
    try {
      const s = await stat(`${dir}/${it.name}`)
      it.size = s.size
      total += s.size
    } catch {
      // 统计失败忽略
    }
  }
  for (const it of logs) {
    if (total <= maxBytes) break
    try {
      await remove(`${dir}/${it.name}`)
      total -= it.size
    } catch {
      // 删除失败忽略
    }
  }
}

/** 初始化日志文件目录（Tauri：appConfigDir/logs）；非 Tauri 仅保留内存缓冲。幂等。 */
export async function initLogger(): Promise<void> {
  if (started) return
  started = true
  if (!isTauri()) return
  try {
    // 安全：日志写入独立的应用日志目录（$APPLOG），不再使用 appConfigDir——
    // 避免为写日志而授予前端对整个配置目录（app.db / lu-secrets.json / lu-config.json）的写权限。
    const { appLogDir } = await import('@tauri-apps/api/path')
    const dir = await appLogDir()
    fileDir = dir.replace(/[\\/]+$/, '')
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    fileBase = `lu-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`
  } catch {
    fileDir = null
    fileBase = null
  }
  // 初始化后立即确保日志文件存在（含被删后重建）
  void touchLog()
}

/** 返回当前 webview 内存日志快照（查看器用） */
export function getLogs(): LogEntry[] {
  return buffer.slice()
}

/** 返回当前 webview 内存日志的纯文本（导出/复制用） */
export function getLogText(): string {
  const t = buffer.map(jsonLine).join('\n')
  return t.length > 0 ? `${t}\n` : ''
}

/** 落盘目录（导出/打开目录用；非 Tauri 返回 null） */
export function getLogDir(): string | null {
  return fileDir ? `${fileDir}` : null
}

/**
 * 清空调试日志：删除日志目录下全部 lu-*.log 文件，并清空内存缓冲与待写队列。
 * 供 LogViewer「清空」与设置页「清空日志」调用（轮 G / T4）。
 */
export async function clearLogs(): Promise<number> {
  buffer.length = 0
  pending.length = 0
  if (!fileDir) return 0
  let removed = 0
  const failures: string[] = []
  // 轮 I（#1）：删除日志目录下「全部」文件（各日期 lu-*.log、lu-rust-YYYY-MM-DD.log、滚动归档、导出），
  // 而非只清当天。返回删除数量供 UI 反馈。失败不再静默吞掉（此前因 fs scope 缺写权限而「看似删了实则没删」）。
  try {
    const { readDir, remove } = await import('@tauri-apps/plugin-fs')
    const items = await readDir(fileDir)
    for (const it of items) {
      if (it.isDirectory) continue
      try {
        await remove(`${fileDir}/${it.name}`)
        removed += 1
      } catch (e) {
        failures.push(`${it.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    failures.push(`readDir(${fileDir}): ${e instanceof Error ? e.message : String(e)}`)
  }
  // 注：lu-diag.log 已随日志一起迁入 $APPLOG，上面遍历删除时已覆盖，无需单独处理。
  if (failures.length > 0) {
    // 不阻断主流程，但必须留痕（便于定位 fs 权限/占用问题）
    console.warn('[lu] 清空日志部分失败：', failures)
  }
  // 清空后立即重建空日志文件，避免「删除后不再写入」的观感
  void touchLog()
  return removed
}

// M06 · core/tasks — 任务状态机 + 取消 + 队列 + 落库 + 任务聚合 + 事件推送
// UI 只经此模块发起解析（plan/01 §五 规则 1：UI 不直接调 core/client）。
// 取消检查点：轮询每轮 + 下载中（AbortController 贯穿 HTTP，OT-X021/039 语义）。
// 完成判定参照 MB-X088（allSettled：done/failed 均计终态）。
// 阶段 3：可选 store 落库（T3-03）、队列顺序执行（T3-04）、取消（T3-05）、重试（T3-06）、恢复（T3-07）。
// 阶段 4：D-39 任务聚合（1 任务 = N 文件，向后兼容：1 文件路径 taskId===fileId）；T4-08 事件推送。
// 向后兼容：createJob/submit/runJob/retry/cancel(fileId)/getJob/listJobs 行为不变（内部按 1 文件任务处理）。

import { runParseJob } from '../pipeline'
import { resolveActivePromptContent, resolveCaptionEnabled, rerunCaption } from '../caption'
import { BmuError, isBmuError } from '../client/errors'
import { createFsAdapter } from '../platform/fs'
import { createHttpTransport } from '../platform/http'
import { createConfigStore } from '../platform/store'
import { createSecretsAdapter } from '../platform/secrets'
import { loadConfig } from '../config'
import { emitHistoryChanged, emitLogLine, emitTaskProgress, emitTaskStatus } from '../platform/events'
import { log } from '../platform/logger'
import { pushUserMessage } from '../platform/user-feed'
import { toUserMessageOrGeneric, errorKindToCode } from '../platform/user-messages'
import type { Store, TaskRow } from '../store'
import type {
  AppConfig,
  BmuErrorKind,
  CaptionWriteMode,
  Job,
  JobEvent,
  JobStatus,
  OutputFormat,
  OutputKind,
  PipelineEvent,
  PipelinePhase,
  SameNameHandling,
} from '../types'

export type JobListener = (event: JobEvent) => void

export interface SubmitMeta {
  captionEnabled?: boolean
  processingLocation?: 'workbench' | 'inplace'
  /** T5-02/T5-05：本任务输出行为（UI 按入口配置写入 createTask，runJob 读取后透传 pipeline） */
  format?: OutputFormat
  /** D-98：输出内容多选（markdown/json/docx/html/images），透传给 pipeline 做请求与落盘过滤 */
  outputs?: OutputKind[]
  captionMode?: CaptionWriteMode
  sameNameHandling?: SameNameHandling
  /** 默认输出目录覆盖（入口配置 defaultDir；空 = 源目录/工作区） */
  destDir?: string
  /** 完成后自动打开输出目录（入口配置 autoOpen） */
  autoOpen?: boolean
}

/** 执行接缝（单测用）：默认 undefined → 走真实 runJob；注入后可脱离真实 pipeline 测试队列/取消/重试。 */
export type TaskRunner = (jobId: string, signal: AbortSignal) => Promise<Job>

/** 任务（D-39）：1 任务 = N 文件 */
interface TaskRecord {
  id: string
  createdAt: number
  updatedAt: number
  status: JobStatus
  fileIds: string[]
  meta: SubmitMeta
}

const PHASE_TO_STATUS: Record<PipelinePhase, JobStatus> = {
  validating: 'pending',
  reading: 'pending',
  uploading: 'uploading',
  polling: 'polling',
  downloading: 'downloading',
  extracting: 'extracting',
  writing: 'writing',
  done: 'done',
  failed: 'failed',
  canceled: 'canceled',
}

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'failed', 'canceled', 'interrupted'])

function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function isTerminalStatus(s: JobStatus): boolean {
  return TERMINAL.has(s)
}

export class TaskManager {
  private readonly jobs = new Map<string, Job>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<JobListener>()
  private readonly meta = new Map<string, SubmitMeta>()
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly fileToTask = new Map<string, string>()
  private readonly queue: string[] = []
  private draining = false
  private jobSeq = 0
  private taskSeq = 0

  constructor(
    private config: AppConfig,
    private readonly store?: Store,
    private readonly runner?: TaskRunner,
  ) {}

  /** 工厂：加载完整配置（含密钥注入）后创建（不挂 store，内存态；store 接线属 T3-12） */
  static async create(): Promise<TaskManager> {
    const config = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() })
    return new TaskManager(config)
  }

  getConfig(): AppConfig {
    return this.config
  }

  /**
   * T5-F：热更新配置（设置页保存后，运行中的 TaskManager 需刷新，否则 startAll/runJob 仍用挂载时的旧配置，
   * 表现为「设置自动保存但输出不变」）。替换内部 config 引用；不影响已入队/运行中的任务语义。
   */
  applyConfig(config: AppConfig): void {
    this.config = config
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: JobEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 监听者异常不影响状态机
      }
    }
  }

  // ---------------------------------------------------------------- 任务/文件创建（D-39）

  private makeJob(inputPath: string): Job {
    this.jobSeq += 1
    const now = Date.now()
    return {
      id: `job_${now.toString(36)}_${this.jobSeq}`,
      inputPath,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      error: null,
      errorKind: null,
      outputDir: null,
      batchId: null,
      retryCount: 0,
    }
  }

  /** 向后兼容：创建 1 文件任务（taskId===fileId），返回文件级 Job 视图。 */
  createJob(inputPath: string, meta?: SubmitMeta): Job {
    const job = this.makeJob(inputPath)
    this.jobs.set(job.id, job)
    this.tasks.set(job.id, { id: job.id, createdAt: job.createdAt, updatedAt: job.updatedAt, status: 'pending', fileIds: [job.id], meta: meta ?? {} })
    this.fileToTask.set(job.id, job.id)
    this.meta.set(job.id, meta ?? {})
    return job
  }

  /** D-39：创建 1 任务 + N 文件并落库；返回 taskId。 */
  async createTask(files: string[], meta: SubmitMeta = {}): Promise<string> {
    if (files.length === 0) throw new BmuError('business', 'createTask 需要至少 1 个文件', { code: 'EMPTY_TASK' })
    this.taskSeq += 1
    const now = Date.now()
    const taskId = `task_${now.toString(36)}_${this.taskSeq}`
    const fileIds: string[] = []
    for (const f of files) {
      const job = this.makeJob(f)
      this.jobs.set(job.id, job)
      this.fileToTask.set(job.id, taskId)
      this.meta.set(job.id, meta)
      fileIds.push(job.id)
    }
    this.tasks.set(taskId, { id: taskId, createdAt: now, updatedAt: now, status: 'pending', fileIds, meta })
    if (this.store) {
      await this.store.saveTask(this.taskRowOf(taskId))
      for (const f of files) {
        await this.store.updateFile(taskId, { name: baseName(f) }, { name: baseName(f), inputPath: f, status: 'pending' })
      }
      emitHistoryChanged(taskId)
    }
    return taskId
  }

  /**
   * 轮 I：把历史任务从 DB 载入内存（历史栏点击文件 → 继续到进度面板）。
   * 已载入则直接返回 true。历史行缺少 input_path 时回退用任务级 inputPath。
   */
  async loadTask(taskId: string): Promise<boolean> {
    if (!this.store) return false
    if (this.tasks.has(taskId)) return true
    const row = await this.store.getTask(taskId)
    if (!row) return false
    const files = await this.store.loadFiles(taskId)
    const fileIds: string[] = []
    for (const f of files) {
      const inputPath = f.inputPath ?? row.inputPath
      const job = this.makeJob(inputPath)
      job.status = (f.status as JobStatus) ?? 'pending'
      job.outputDir = f.outputPath ?? null
      job.markdownPath = f.markdownPath ?? undefined
      job.error = row.error ?? null
      this.jobs.set(job.id, job)
      this.fileToTask.set(job.id, taskId)
      this.meta.set(job.id, {
        captionEnabled: row.captionEnabled,
        processingLocation: row.processingLocation,
      })
      fileIds.push(job.id)
    }
    this.tasks.set(taskId, { id: taskId, createdAt: row.createdAt, updatedAt: row.updatedAt, status: row.status, fileIds, meta: {} })
    log('info', 'tasks', 'loadTask', { taskId, files: fileIds.length })
    return true
  }

  /** 轮 I：向已存在任务追加文件（任务=容器，随时写入）。返回追加数量。 */
  async appendFiles(taskId: string, files: string[], meta: SubmitMeta = {}): Promise<number> {
    const t = this.tasks.get(taskId)
    if (!t) throw new BmuError('business', `任务不存在：${taskId}`, { code: 'NO_TASK' })
    let added = 0
    for (const f of files) {
      const job = this.makeJob(f)
      this.jobs.set(job.id, job)
      this.fileToTask.set(job.id, taskId)
      this.meta.set(job.id, meta)
      t.fileIds.push(job.id)
      added += 1
      if (this.store) {
        await this.store.updateFile(taskId, { name: baseName(f) }, { name: baseName(f), inputPath: f, status: 'pending' })
      }
    }
    t.updatedAt = Date.now()
    if (this.store) {
      await this.store.saveTask(this.taskRowOf(taskId))
      emitHistoryChanged(taskId)
    }
    log('info', 'tasks', 'appendFiles', { taskId, added })
    return added
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId)
  }

  listJobs(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** D-39：任务信息（UI 用） */
  getTaskInfo(taskId: string): { id: string; status: JobStatus; createdAt: number; updatedAt: number; fileIds: string[] } | undefined {
    const t = this.tasks.get(taskId)
    return t ? { id: t.id, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt, fileIds: [...t.fileIds] } : undefined
  }

  /** D-39：任务下的文件 Job 视图（按创建顺序） */
  taskFiles(taskId: string): Job[] {
    const t = this.tasks.get(taskId)
    if (!t) return []
    return t.fileIds.map((id) => this.jobs.get(id)).filter((j): j is Job => !!j)
  }

  /**
   * D-52/D.8：手动刷新——返回当前任务的权威内存态文件快照（UI 立即同步，不等事件/轮询间隔）。
   * 说明：各文件解析状态由 pipeline 内部轮询推进并写入 job.status，此处刷新即取最新已知态，
   * 并顺带重算任务聚合态；无需额外服务端状态查询接口。
   */
  refreshStatus(taskId: string): Job[] {
    this.touchTask(taskId)
    return this.taskFiles(taskId).map((j) => ({ ...j }))
  }

  private taskRowOf(taskId: string): TaskRow {
    const t = this.tasks.get(taskId)
    const first = t ? this.jobs.get(t.fileIds[0]) : undefined
    const meta = t?.meta ?? {}
    return {
      id: taskId,
      inputPath: first?.inputPath ?? '',
      fileName: baseName(first?.inputPath ?? ''),
      status: t?.status ?? 'pending',
      createdAt: t?.createdAt ?? Date.now(),
      updatedAt: t?.updatedAt ?? Date.now(),
      outputDir: first?.outputDir ?? null,
      batchId: first?.batchId ?? null,
      captionEnabled: meta.captionEnabled ?? false,
      processingLocation: meta.processingLocation ?? 'workbench',
      error: null,
      errorKind: null,
      errorStage: null,
      retryCount: 0,
    }
  }

  /** 聚合态：全终态→done/failed/canceled；否则取首个未终态文件状态 */
  private taskAggregate(taskId: string): JobStatus {
    const files = this.taskFiles(taskId)
    if (files.length === 0) return 'pending'
    if (files.every((f) => isTerminalStatus(f.status))) {
      if (files.every((f) => f.status === 'done')) return 'done'
      if (files.some((f) => f.status === 'failed')) return 'failed'
      return 'canceled'
    }
    const active = files.find((f) => !isTerminalStatus(f.status))
    return active ? active.status : 'pending'
  }

  private touchTask(taskId: string): void {
    const t = this.tasks.get(taskId)
    if (t) {
      t.status = this.taskAggregate(taskId)
      t.updatedAt = Date.now()
    }
  }

  // ---------------------------------------------------------------- 队列（T3-04 + D-39）

  /** 向后兼容：入队单文件（1 文件任务），返回 Job。 */
  async submit(inputPath: string, meta?: SubmitMeta): Promise<Job> {
    const job = this.createJob(inputPath, meta)
    if (this.store) {
      await this.store.saveTask(this.taskRowOf(job.id))
      await this.store.updateFile(job.id, { name: baseName(inputPath) }, { name: baseName(inputPath), status: 'pending' })
    }
    this.queue.push(job.id)
    void this.drain()
    return job
  }

  /** D-39：按顺序入队该任务下所有未终态文件。concurrency = 并发执行数（不传 = queueConcurrency）。 */
  async submitAll(taskId: string, concurrency?: number): Promise<void> {
    const t = this.tasks.get(taskId)
    if (!t) throw new BmuError('business', `任务不存在：${taskId}`, { code: 'NO_TASK' })
    const before = this.queue.length
    const enqueued: string[] = []
    for (const fid of t.fileIds) {
      const job = this.jobs.get(fid)
      if (job && !isTerminalStatus(job.status) && !this.queue.includes(fid)) {
        this.queue.push(fid)
        enqueued.push(fid)
      }
    }
    log('info', 'tasks', 'submitAll.enter', { taskId, enqueued: enqueued.length, queueBefore: before, queueAfter: this.queue.length })
    void this.drain(concurrency)
  }

  /**
   * T5-F：并发 drain。此前为顺序执行（等上一个完全部才下一个），批量时慢。
   * 现按 concurrency 拉起并发 worker 池，从共享 queue 取任务执行；取消/终态语义不变
   * （每个 job 独立 AbortController，由 runJob 自注册）。draining 期间新入队任务由存活 worker 继续消费。
   */
  private async drain(concurrency?: number): Promise<void> {
    if (this.draining) return
    this.draining = true
    const requested = Math.max(1, concurrency ?? this.config.tasks.queueConcurrency)
    // Agent 轻量解析按 IP 限频（长 PDF 还会拆成多片逐片提交）：文件间统一强制串行，避免叠加触发 429。
    // 放在 drain 层可覆盖主窗口 / 解析对话框 / 进度窗全部入口，无需各调用点分别传参。
    const limit = this.config.mineru.apiMode === 'agent' ? 1 : requested
    log('debug', 'tasks', 'drain.start', { queueLen: this.queue.length, concurrency: limit, requested, agentMode: this.config.mineru.apiMode === 'agent' })
    try {
      const worker = async (): Promise<void> => {
        for (;;) {
          if (this.queue.length === 0) return
          const jobId = this.queue.shift()!
          const job = this.jobs.get(jobId)
          // 已在队列期间被取消/终态的，跳过（T3-05）
          if (!job || isTerminalStatus(job.status)) continue
          log('debug', 'tasks', 'drain.pick', { jobId, remaining: this.queue.length })
          if (this.runner) {
            const controller = new AbortController()
            this.controllers.set(jobId, controller)
            try {
              await this.runner(jobId, controller.signal)
              this.touchTask(this.fileToTask.get(jobId) ?? jobId)
            } catch {
              // runner 内部自管终态
            } finally {
              this.controllers.delete(jobId)
            }
          } else {
            try {
              await this.runJob(jobId)
            } catch {
              // runJob 内部已落终态
            }
          }
        }
      }
      const n = Math.min(limit, Math.max(1, this.queue.length))
      const workers: Promise<void>[] = []
      for (let i = 0; i < n; i += 1) workers.push(worker())
      await Promise.all(workers)
    } finally {
      this.draining = false
      log('debug', 'tasks', 'drain.end')
    }
  }

  // ---------------------------------------------------------------- 取消（T3-05 + D-39）

  /** 取消：入参为 taskId → 取消该任务下所有未终态文件；为 fileId → 取消该文件（向后兼容）。 */
  cancel(id: string): boolean {
    log('info', 'tasks', 'cancel', { id })
    const task = this.tasks.get(id)
    if (task) {
      let any = false
      for (const fid of task.fileIds) any = this.cancelFile(fid) || any
      return any
    }
    return this.cancelFile(id)
  }

  private cancelFile(jobId: string): boolean {
    const controller = this.controllers.get(jobId)
    if (controller) {
      controller.abort()
      return true
    }
    const idx = this.queue.indexOf(jobId)
    if (idx >= 0) {
      this.queue.splice(idx, 1)
      const job = this.jobs.get(jobId)
      if (job) {
        job.status = 'canceled'
        job.updatedAt = Date.now()
        const taskId = this.fileToTask.get(jobId) ?? jobId
        this.touchTask(taskId)
        if (this.store) {
          void this.store.updateTask(taskId, { status: this.taskAggregate(taskId), updatedAt: job.updatedAt })
          void this.store.updateFile(taskId, { name: baseName(job.inputPath) }, { status: 'canceled' })
        }
        emitTaskStatus({ taskId, fileId: jobId, state: 'canceled' })
      }
      return true
    }
    return false
  }

  /** 队列级取消：清空待执行队列并将其中文件标记 canceled。 */
  clearQueue(): number {
    let n = 0
    while (this.queue.length > 0) {
      const id = this.queue.shift()!
      const job = this.jobs.get(id)
      if (job) {
        job.status = 'canceled'
        job.updatedAt = Date.now()
        const taskId = this.fileToTask.get(id) ?? id
        this.touchTask(taskId)
        if (this.store) {
          void this.store.updateTask(taskId, { status: this.taskAggregate(taskId), updatedAt: job.updatedAt })
          void this.store.updateFile(taskId, { name: baseName(job.inputPath) }, { status: 'canceled' })
        }
      }
      n += 1
    }
    log('debug', 'tasks', 'clearQueue', { count: n })
    return n
  }

  // ---------------------------------------------------------------- 重试（T3-06 + D-39 retryFile）

  /** D-39：重试任务下的单个文件（不影响同任务其他文件）。 */
  async retryFile(taskId: string, fileId: string): Promise<Job> {
    if (this.fileToTask.get(fileId) !== taskId) {
      throw new BmuError('business', `文件不属于该任务：${fileId}`, { code: 'FILE_TASK_MISMATCH' })
    }
    log('info', 'tasks', 'retryFile', { taskId, fileId })
    return this.retry(fileId)
  }

  /**
   * D-41：重试任务下所有失败文件（历史列表「重试」入口）。
   * 逐文件受 tasks.maxRetries 上限约束；返回实际重试数量。
   */
  async retryTask(taskId: string): Promise<{ retried: number; skipped: number }> {
    const t = this.tasks.get(taskId)
    if (!t) throw new BmuError('business', `任务不存在：${taskId}`, { code: 'NO_TASK' })
    let retried = 0
    let skipped = 0
    for (const fid of t.fileIds) {
      const job = this.jobs.get(fid)
      if (!job || job.status !== 'failed') continue
      try {
        await this.retry(fid)
        retried += 1
      } catch {
        // 达到重试上限等：跳过该文件
        skipped += 1
      }
    }
    log('info', 'tasks', 'retryTask', { taskId, retried, skipped })
    return { retried, skipped }
  }

  /** 向后兼容：手动重试单个文件，受 tasks.maxRetries 上限约束，retry_count 递增并落库。 */
  async retry(jobId: string): Promise<Job> {
    const job = this.jobs.get(jobId)
    if (!job) throw new BmuError('business', `任务不存在：${jobId}`, { code: 'NO_JOB' })
    // D-96：原实现只允许 failed，导致「已完成的文件点重试」直接报错。
    // 终态（done/failed/canceled/interrupted）都应允许重新解析；执行中的状态需先停止。
    const TERMINAL_STATUSES: JobStatus[] = ['done', 'failed', 'canceled', 'interrupted']
    if (!TERMINAL_STATUSES.includes(job.status)) {
      throw new BmuError('business', `任务正在执行中，请先停止再重试（当前 ${job.status}）`, { code: 'NOT_RETRYABLE' })
    }
    // 轮 I：手动重试不再受 tasks.maxRetries 限制（默认 0 会导致点击重试立即失败）。
    // maxRetries 保留给未来的自动重试策略；此处仅对超限做提示，不阻断。
    const max = this.config.tasks.maxRetries
    if (max > 0 && job.retryCount >= max) {
      log('warn', 'tasks', 'retry.overLimit', { jobId, retryCount: job.retryCount, max })
    }
    job.retryCount += 1
    log('info', 'tasks', 'retry', { jobId, attempt: job.retryCount, max: this.config.tasks.maxRetries })
    job.status = 'pending'
    job.error = null
    job.errorKind = null
    const now = Date.now()
    job.updatedAt = now
    const taskId = this.fileToTask.get(jobId) ?? jobId
    this.touchTask(taskId)
    if (this.store) {
      await this.store.updateFile(taskId, { name: baseName(job.inputPath) }, { status: 'pending', errMsg: '' })
      await this.store.updateTask(taskId, { status: this.taskAggregate(taskId), updatedAt: now })
    }
    emitTaskStatus({ taskId, fileId: jobId, state: 'pending' })
    return this.runJob(jobId)
  }

  // ---------------------------------------------------------------- 崩溃恢复（T3-07）

  static async recover(store: Store, staleTimeoutMs: number): Promise<{ interrupted: number; failed: number }> {
    return store.recover(staleTimeoutMs)
  }

  // ---------------------------------------------------------------- 执行（T1-15 + T3-03 落库 + T4-08 事件）

  /** 执行一个文件：驱动 pipeline 并维护状态机；返回终态 Job（fileId 即 jobId）。 */
  async runJob(jobId: string): Promise<Job> {
    const job = this.jobs.get(jobId)
    if (!job) throw new BmuError('business', `任务不存在：${jobId}`, { code: 'NO_JOB' })
    if (isTerminalStatus(job.status)) {
      throw new BmuError('business', `任务已处于终态（${job.status}）：${jobId}`, { code: 'JOB_TERMINAL' })
    }
    if (this.controllers.has(jobId)) {
      throw new BmuError('business', `任务正在运行：${jobId}`, { code: 'JOB_RUNNING' })
    }

    const taskId = this.fileToTask.get(jobId) ?? jobId
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    const startedAt = Date.now()
    // 每次执行（含重试）都从干净的进度快照开始，避免沿用上一次的拆分进度
    job.progress = undefined
    log('info', 'tasks', 'runJob.enter', { jobId, taskId, file: baseName(job.inputPath) })

    const storeOps: Promise<void>[] = []
    const persist = (patch: { error?: string | null; errorKind?: BmuErrorKind | null; errorStage?: string | null; outputDir?: string | null }): void => {
      this.touchTask(taskId)
      if (!this.store) return
      storeOps.push(
        this.store.updateFile(taskId, { name: baseName(job.inputPath) }, {
          inputPath: job.inputPath,
          status: job.status,
          errMsg: patch.error ?? '',
          outputPath: patch.outputDir ?? job.outputDir ?? null,
          markdownPath: job.markdownPath,
        }),
      )
      storeOps.push(
        this.store.updateTask(taskId, { status: this.taskAggregate(taskId), updatedAt: job.updatedAt, outputDir: job.outputDir ?? undefined }),
      )
    }

    const onEvent = (event: PipelineEvent): void => {
      if (event.type === 'phase' && event.phase) {
        job.status = PHASE_TO_STATUS[event.phase]
        job.updatedAt = Date.now()
        persist({ errorStage: event.phase })
        emitTaskStatus({ taskId, fileId: jobId, state: job.status, stage: event.phase })
      } else if (event.type === 'progress') {
        // 汇总为 Job 的运行时进度快照：状态列据此显示分片进度与云端状态文案
        job.progress = {
          ...job.progress,
          ...(event.cloudState !== undefined ? { cloudState: event.cloudState } : {}),
          ...(event.partIndex !== undefined ? { partIndex: event.partIndex, partTotal: event.partTotal } : {}),
          ...(event.extractedPages !== undefined ? { extractedPages: event.extractedPages, totalPages: event.totalPages } : {}),
        }
        job.updatedAt = Date.now()
        emitTaskProgress({
          taskId,
          fileId: jobId,
          elapsedMs: Date.now() - startedAt,
          partIndex: event.partIndex,
          partTotal: event.partTotal,
        })
      } else if (event.type === 'log' && event.message) {
        emitLogLine({ taskId, level: 'info', message: event.message, timestamp: Date.now() })
      }
      this.emit({ jobId, event, at: Date.now() })
    }

    try {
      // 落库：确保任务行存在（幂等）。置于 try 内：若落库异常会被下方 catch 捕获并标记 failed，
      // 而非像此前那样抛出到 drain 的「静默吞掉」分支，导致任务永远卡在 pending（D.10）。
      if (this.store && this.tasks.has(taskId)) {
        await this.store.saveTask(this.taskRowOf(taskId))
      }
      if (this.runner) {
        // 测试接缝：runner 自管 job 状态推进
        await this.runner(jobId, controller.signal)
        this.touchTask(taskId)
      } else {
        // 每次开启/重试都采用「执行当时」的配置，而非建任务时固化的 meta 快照。
        // 配置由 applyConfig 保持最新（设置页保存、各入口开启/重试前均会同步）；
        // 此处不重新 loadConfig，避免覆盖运行时注入的 Token/密钥与设置页尚未落盘的编辑。
        const cfg = this.config
        const entry = cfg.output.entry === 'context-menu' ? cfg.output.rightClick : cfg.output.workbench
        const captionEnabled = resolveCaptionEnabled(entry.captionEnabled, undefined)
        const outputs = entry.outputs
        const format = entry.format
        const captionMode = entry.captionMode
        const transport = createHttpTransport(cfg.http.transport)
        const fs = createFsAdapter()
        const destDirOverride = job.destDirOverride ?? (entry.defaultDir.trim() ? entry.defaultDir : undefined)
        const result = await runParseJob(
          { filePath: job.inputPath },
          {
            config: cfg,
            transport,
            fs,
            onEvent,
            signal: controller.signal,
            store: this.store,
            taskId,
            destDirOverride,
            outputFormat: format,
            sameNameHandling: cfg.output.sameNameHandling,
            // D-97：把图片描述开关带进解析层，用于「必须保留图片」的落盘决策
            captionEnabled,
            // D-98：输出内容多选，决定请求哪些额外格式与落盘哪些文件
            outputs,
          },
        )
        job.outputDir = result.outputDir
        job.batchId = result.batchId
        job.markdownPath = result.markdownPath ?? undefined
        job.status = 'done'
        job.error = null
        job.updatedAt = Date.now()
        persist({})
        emitTaskStatus({ taskId, fileId: jobId, state: 'done' })
        log('info', 'tasks', 'runJob.done', { jobId, taskId, durationMs: Date.now() - startedAt })
        // T5-02/T5-05：开启图片描述时，解析成功后按当时的 captionMode / 提示词方案回写
        // （旁路步骤；失败不影响解析终态）。Agent 仅产出 Markdown，跳过回写。
        /** D-99：本次图片描述是否成功产出（null = 未运行），决定 DOCX 的 images/ 是否可清理 */
        let captionDescribed: number | null = null
        if (cfg.mineru.apiMode !== 'agent' && captionEnabled) {
          try {
            // D-97：启用图片描述时解析层已强制保留完整产物（含 images/）。
            // 若入口选择的是「仅 Markdown」，此处说明为何仍出现图片目录，避免用户误以为设置失效。
            if (format === 'markdown') {
              onEvent({ type: 'log', message: '图片描述已启用：本次保留 images/ 等中间产物以供读图；如需纯 Markdown，请关闭图片描述后重新解析。' })
            }
            const cap = await rerunCaption(
              { config: cfg, transport, fs },
              {
                outputDir: result.outputDir,
                mode: captionMode,
                enabledDefault: entry.captionEnabled,
                // 轮 J：使用设置中当前选中的提示词方案（内置 4 套 / 用户自定义）
                customUserPrompt: resolveActivePromptContent(cfg.multimodal),
                signal: controller.signal,
                onLog: (m) => onEvent({ type: 'log', message: m }),
              },
            )
            captionDescribed = cap.stats.described
          } catch (err) {
            onEvent({ type: 'log', message: `图片描述失败（不影响解析结果）：${err instanceof Error ? err.message : String(err)}` })
          }
        }

        /**
         * 图片保留规则（与设置页文案一致）：
         * - 勾选「图片」→ 保留 images/（用户需要单独图片，可直接读取）；
         * - 未勾选「图片」→ 图片描述读取完成后删除临时 images/（DOCX 自带图片，无需重复占用）。
         * 例外：同时输出 Markdown 且写入方式为「两者都有」时，md 仍引用图片，删除会造成断链，故保留。
         * 仅在「确有描述成功」时清理——全部失败时保留图片，便于用户重试。
         */
        {
          // 按本次执行时生效的输出多选与写入方式决定，不再依赖建任务时的快照
          const keepImages = outputs.includes('images')
          const keepForMarkdown = outputs.includes('markdown') && captionMode === 'both'
          const describedOk = captionDescribed !== null && captionDescribed > 0
          if (!keepImages && !keepForMarkdown && describedOk && fs.removeDir) {
            const imagesDir = `${result.outputDir.replace(/[\\/]+$/, '')}/images`
            try {
              await fs.removeDir(imagesDir)
              onEvent({ type: 'log', message: '未勾选「图片」：图片描述已读取，已清理临时 images 目录' })
            } catch (err) {
              onEvent({ type: 'log', message: `清理 images 目录失败（不影响结果）：${err instanceof Error ? err.message : String(err)}` })
            }
          }
        }
      }
    } catch (err) {
      const lu = isBmuError(err) ? err : new BmuError('internal', err instanceof Error ? err.message : String(err))
      // D.10：失败明确写日志，避免「卡在等待中」却无任何线索
      emitLogLine({ taskId, level: 'error', message: `解析失败（${baseName(job.inputPath)}）：${lu.message}`, timestamp: Date.now() })
      log('error', 'tasks', 'runJob.failed', { jobId, taskId, kind: lu.kind, stage: lu.stage, message: lu.message })
      // 轮 G 日志重构：把失败映射为用户通知（按错误类别分流，无技术黑话）；取消为用户主动，不弹窗
      if (lu.kind !== 'canceled') {
        pushUserMessage(
          toUserMessageOrGeneric(errorKindToCode(lu.kind, { message: lu.message }), {
            file: baseName(job.inputPath),
            message: lu.message,
          }),
        )
      }
      job.status = lu.kind === 'canceled' ? 'canceled' : 'failed'
      job.error = lu.message
      job.errorKind = lu.kind
      job.updatedAt = Date.now()
      persist({ error: lu.message, errorKind: lu.kind, errorStage: 'error' })
      emitTaskStatus({ taskId, fileId: jobId, state: job.status, error: lu.message })
      onEvent({ type: 'phase', phase: job.status === 'canceled' ? 'canceled' : 'failed' })
    } finally {
      if (storeOps.length > 0) await Promise.all(storeOps)
      this.controllers.delete(jobId)
      // D-45：落库后广播历史变更（其他窗口异步刷新）
      if (this.store) emitHistoryChanged(taskId)
    }
    return job
  }
}

/** T3-10 完成判定：批次内所有文件均终态（done/failed），空批次不计完成。 */
export function isBatchComplete(files: Array<{ status: string }>): boolean {
  return files.length > 0 && files.every((f) => f.status === 'done' || f.status === 'failed')
}

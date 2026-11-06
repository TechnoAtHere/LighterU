// core/store — SQLite 历史/任务持久化（T3-01 DDL + T3-02 CRUD；T3-07 恢复；T3-08 断点字段）
// 依赖注入：接收 SqlAdapter，dev/selftest 传内存库，Tauri 传 plugin-sql 实例。
// 两级表（一对多，D-32 后无方案表）：
//   tasks（任务/批） 1 ──* task_files（批内文件级状态 + 上传/指纹，断点用）
// 字段依据 MB-X042/043 + 需求终版 §六记录字段 + 阶段 3 落库需求。

import type { SqlAdapter, SqlRow } from '../platform/sql'
import type { JobStatus } from '../types'
import { log } from '../platform/logger'

export interface TaskRow {
  id: string
  inputPath: string
  fileName: string
  status: JobStatus
  createdAt: number
  updatedAt: number
  outputDir: string | null
  batchId: string | null
  captionEnabled: boolean
  processingLocation: 'workbench' | 'inplace'
  error: string | null
  errorKind: string | null
  errorStage: string | null
  retryCount: number
}

export interface TaskFileRow {
  id: number
  taskId: string
  name: string
  inputPath: string | null
  dataId: string | null
  status: string
  errMsg: string
  fingerprint: string
  optionsHash: string
  uploadStatus: string
  outputPath: string | null
  markdownPath: string | null
}

export type TaskPatch = Partial<Pick<
  TaskRow,
  'fileName' | 'status' | 'updatedAt' | 'outputDir' | 'batchId' | 'error' | 'errorKind' | 'errorStage' | 'retryCount' | 'captionEnabled' | 'processingLocation'
>>

export type TaskFilePatch = Partial<Pick<
  TaskFileRow, 'name' | 'inputPath' | 'dataId' | 'status' | 'errMsg' | 'fingerprint' | 'optionsHash' | 'uploadStatus' | 'outputPath' | 'markdownPath'
>>

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  input_path            TEXT NOT NULL,
  file_name             TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'pending',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  output_dir            TEXT,
  batch_id              TEXT,
  caption_enabled       INTEGER NOT NULL DEFAULT 0,
  processing_location   TEXT NOT NULL DEFAULT 'workbench',
  error                 TEXT,
  error_kind            TEXT,
  error_stage           TEXT,
  retry_count           INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  input_path    TEXT,
  data_id       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  err_msg       TEXT NOT NULL DEFAULT '',
  fingerprint   TEXT NOT NULL DEFAULT '',
  options_hash  TEXT NOT NULL DEFAULT '',
  upload_status TEXT NOT NULL DEFAULT '',
  output_path   TEXT,
  markdown_path TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
`

function rowToTask(r: SqlRow): TaskRow {
  return {
    id: String(r.id),
    // 旧行可能没有 input_path（列新增前）→ 空串，避免渲染层显示 "null" / 调用 toLowerCase 异常
    inputPath: r.input_path == null ? '' : String(r.input_path),
    fileName: String(r.file_name ?? ''),
    status: r.status as JobStatus,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    outputDir: r.output_dir == null ? null : String(r.output_dir),
    batchId: r.batch_id == null ? null : String(r.batch_id),
    captionEnabled: Number(r.caption_enabled) !== 0,
    processingLocation: (r.processing_location as 'workbench' | 'inplace') ?? 'workbench',
    error: r.error == null ? null : String(r.error),
    errorKind: r.error_kind == null ? null : String(r.error_kind),
    errorStage: r.error_stage == null ? null : String(r.error_stage),
    retryCount: Number(r.retry_count ?? 0),
  }
}

function rowToFile(r: SqlRow): TaskFileRow {
  return {
    id: Number(r.id),
    taskId: String(r.task_id),
    name: String(r.name ?? ''),
    inputPath: r.input_path == null ? null : String(r.input_path),
    dataId: r.data_id == null ? null : String(r.data_id),
    status: String(r.status ?? 'pending'),
    errMsg: String(r.err_msg ?? ''),
    fingerprint: String(r.fingerprint ?? ''),
    optionsHash: String(r.options_hash ?? ''),
    uploadStatus: String(r.upload_status ?? ''),
    outputPath: r.output_path == null ? null : String(r.output_path),
    markdownPath: r.markdown_path == null ? null : String(r.markdown_path),
  }
}

export interface Store {
  initSchema(): Promise<void>
  saveTask(row: TaskRow): Promise<void>
  updateTask(id: string, patch: TaskPatch): Promise<void>
  getTask(id: string): Promise<TaskRow | null>
  getHistory(opts?: { status?: JobStatus; limit?: number; offset?: number }): Promise<TaskRow[]>
  getNonTerminal(): Promise<TaskRow[]>
  /** T3-07：扫描未终态任务 → interrupted；超 staleTimeoutMs 的转 failed。返回受影响计数。 */
  recover(staleTimeoutMs: number): Promise<{ interrupted: number; failed: number }>
  loadFiles(taskId: string): Promise<TaskFileRow[]>
  /** upsert 文件行（按 task_id + (data_id 优先, 否则 name) 定位） */
  updateFile(taskId: string, match: { dataId?: string | null; name: string }, fields: TaskFilePatch): Promise<void>
  /** T3-08：记录上传状态 + 文件指纹（断点续传定位） */
  /** T3-08：记录上传状态 + 文件指纹 + 选项哈希（断点续传定位） */
  recordUpload(taskId: string, match: { dataId?: string | null; name: string }, dataId: string, fingerprint: string, optionsHash?: string): Promise<void>
  deleteBatch(taskId: string): Promise<void>
  /** 清空全部历史（轮 H）：删除所有任务及其文件行 */
  deleteAllHistory(): Promise<void>
}

export function createStore(sql: SqlAdapter): Store {
  return {
    async initSchema(): Promise<void> {
      log('debug', 'store', 'initSchema')
      await sql.execute(DDL)
      // 轮 I 迁移：旧库补 input_path 列（已存在则忽略）
      try {
        await sql.execute('ALTER TABLE task_files ADD COLUMN input_path TEXT')
      } catch {
        // 列已存在
      }
      // 轮 I 数据清洗：同名文件历史重复行只保留最新一条（历史 BUG：展开首个文件重复两次/文件数不对）
      try {
        await sql.execute('DELETE FROM task_files WHERE id NOT IN (SELECT MAX(id) FROM task_files GROUP BY task_id, name)')
      } catch {
        // 忽略
      }
      // 轮 I：唯一约束，防止再次产生同名重复行（并发/重复 upsert 场景）
      try {
        await sql.execute('CREATE UNIQUE INDEX IF NOT EXISTS ux_task_files_task_name ON task_files(task_id, name)')
      } catch {
        // 忽略
      }
    },

    async saveTask(row: TaskRow): Promise<void> {
      await sql.execute(
        `INSERT OR REPLACE INTO tasks
          (id, input_path, file_name, status, created_at, updated_at, output_dir, batch_id,
           caption_enabled, processing_location, error, error_kind, error_stage, retry_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.inputPath,
          row.fileName,
          row.status,
          row.createdAt,
          row.updatedAt,
          row.outputDir,
          row.batchId,
          row.captionEnabled ? 1 : 0,
          row.processingLocation,
          row.error,
          row.errorKind,
          row.errorStage,
          row.retryCount,
        ],
      )
    },

    async updateTask(id: string, patch: TaskPatch): Promise<void> {
      const sets: string[] = []
      const params: unknown[] = []
      const set = (col: string, val: unknown): void => {
        sets.push(`${col}=?`)
        params.push(val)
      }
      if (patch.fileName !== undefined) set('file_name', patch.fileName)
      if (patch.status !== undefined) set('status', patch.status)
      if (patch.updatedAt !== undefined) set('updated_at', patch.updatedAt)
      if (patch.outputDir !== undefined) set('output_dir', patch.outputDir)
      if (patch.batchId !== undefined) set('batch_id', patch.batchId)
      if (patch.error !== undefined) set('error', patch.error)
      if (patch.errorKind !== undefined) set('error_kind', patch.errorKind)
      if (patch.errorStage !== undefined) set('error_stage', patch.errorStage)
      if (patch.retryCount !== undefined) set('retry_count', patch.retryCount)
      if (patch.captionEnabled !== undefined) set('caption_enabled', patch.captionEnabled ? 1 : 0)
      if (patch.processingLocation !== undefined) set('processing_location', patch.processingLocation)
      if (sets.length === 0) return
      params.push(id)
      await sql.execute(`UPDATE tasks SET ${sets.join(', ')} WHERE id=?`, params)
    },

    async getTask(id: string): Promise<TaskRow | null> {
      const rows = await sql.select<SqlRow>('SELECT * FROM tasks WHERE id=?', [id])
      return rows.length > 0 ? rowToTask(rows[0]) : null
    },

    async getHistory(opts: { status?: JobStatus; limit?: number; offset?: number } = {}): Promise<TaskRow[]> {
      const limit = opts.limit ?? 100
      const offset = opts.offset ?? 0
      // 轮 J：不再用 `(? IS NULL OR status=?)` 绑定 null（sqlx 对 NULL 参数的处理易导致查询异常/只回 1 条）。
      // 按有无 status 走两条固定 SQL；默认 100 条（D-81 历史=进度另一种视图）。
      const rows = opts.status
        ? await sql.select<SqlRow>(
            'SELECT * FROM tasks WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [opts.status, limit, offset],
          )
        : await sql.select<SqlRow>(
            'SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [limit, offset],
          )
      return rows.map(rowToTask)
    },

    async getNonTerminal(): Promise<TaskRow[]> {
      const rows = await sql.select<SqlRow>(
        `SELECT * FROM tasks WHERE status NOT IN ('done','failed','canceled','interrupted')`,
      )
      return rows.map(rowToTask)
    },

    async recover(staleTimeoutMs: number): Promise<{ interrupted: number; failed: number }> {
      const now = Date.now()
      const nonTerminal = await this.getNonTerminal()
      log('info', 'store', 'recover.enter', { nonTerminal: nonTerminal.length, staleTimeoutMs })
      let interrupted = 0
      let failed = 0
      for (const t of nonTerminal) {
        if (now - t.updatedAt > staleTimeoutMs) {
          await this.updateTask(t.id, {
            status: 'failed',
            updatedAt: now,
            error: '中断超时（进程异常退出，超过 stale 阈值）',
            errorKind: 'internal',
            errorStage: 'recover',
          })
          failed += 1
        } else {
          await this.updateTask(t.id, { status: 'interrupted', updatedAt: now })
          interrupted += 1
        }
      }
      log('info', 'store', 'recover.done', { interrupted, failed })
      return { interrupted, failed }
    },

    async loadFiles(taskId: string): Promise<TaskFileRow[]> {
      // 轮 I：按 name 去重（保留最新 id），避免历史重复行导致展开出现重复文件
      const rows = await sql.select<SqlRow>(
        'SELECT * FROM task_files WHERE task_id=? AND id IN (SELECT MAX(id) FROM task_files WHERE task_id=? GROUP BY name) ORDER BY id ASC',
        [taskId, taskId],
      )
      return rows.map(rowToFile)
    },

    async updateFile(taskId: string, match: { dataId?: string | null; name: string }, fields: TaskFilePatch): Promise<void> {
      const existing = await sql.select<SqlRow>(
        `SELECT * FROM task_files WHERE task_id=? AND (data_id=? OR name=?)`,
        [taskId, match.dataId ?? null, match.name],
      )
      const id = existing.length > 0 ? Number(existing[0].id) : null

      const sets: string[] = []
      const params: unknown[] = []
      const set = (col: string, val: unknown): void => {
        sets.push(`${col}=?`)
        params.push(val)
      }
      if (fields.name !== undefined) set('name', fields.name)
      if (fields.inputPath !== undefined) set('input_path', fields.inputPath)
      if (fields.dataId !== undefined) set('data_id', fields.dataId)
      if (fields.status !== undefined) set('status', fields.status)
      if (fields.errMsg !== undefined) set('err_msg', fields.errMsg)
      if (fields.fingerprint !== undefined) set('fingerprint', fields.fingerprint)
      if (fields.optionsHash !== undefined) set('options_hash', fields.optionsHash)
      if (fields.uploadStatus !== undefined) set('upload_status', fields.uploadStatus)
      if (fields.outputPath !== undefined) set('output_path', fields.outputPath)
      if (fields.markdownPath !== undefined) set('markdown_path', fields.markdownPath)

      if (id != null) {
        if (sets.length === 0) return
        params.push(id)
        await sql.execute(`UPDATE task_files SET ${sets.join(', ')} WHERE id=?`, params)
      } else {
        // INSERT（name 必填，其余取 fields 或默认）
        const name = fields.name ?? match.name
        try {
          await sql.execute(
            `INSERT INTO task_files (task_id, name, input_path, data_id, status, err_msg, fingerprint, options_hash, upload_status, output_path, markdown_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              taskId,
              name,
              fields.inputPath ?? null,
              fields.dataId ?? null,
              fields.status ?? 'pending',
              fields.errMsg ?? '',
              fields.fingerprint ?? '',
              fields.optionsHash ?? '',
              fields.uploadStatus ?? '',
              fields.outputPath ?? null,
              fields.markdownPath ?? null,
            ],
          )
        } catch {
          // 唯一约束冲突（并发/重复 upsert）：回查已有行并改为 UPDATE，避免再产生重复行
          const again = await sql.select<SqlRow>(
            `SELECT id FROM task_files WHERE task_id=? AND name=? ORDER BY id DESC LIMIT 1`,
            [taskId, name],
          )
          if (again.length > 0 && sets.length > 0) {
            params.push(Number(again[0].id))
            await sql.execute(`UPDATE task_files SET ${sets.join(', ')} WHERE id=?`, params)
          }
        }
      }
    },

    async recordUpload(
      taskId: string,
      match: { dataId?: string | null; name: string },
      dataId: string,
      fingerprint: string,
      optionsHash = '',
    ): Promise<void> {
      await this.updateFile(taskId, match, {
        dataId,
        fingerprint,
        optionsHash,
        uploadStatus: 'uploaded',
        status: 'uploaded',
      })
    },

    async deleteBatch(taskId: string): Promise<void> {
      // 外键 ON DELETE CASCADE 已级联 task_files
      await sql.execute('DELETE FROM tasks WHERE id=?', [taskId])
    },

    async deleteAllHistory(): Promise<void> {
      log('info', 'store', 'deleteAllHistory')
      // 外键 ON DELETE CASCADE 已级联 task_files
      await sql.execute('DELETE FROM tasks')
    },
  }
}

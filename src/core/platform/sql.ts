// platform · SQLite 抽象（阶段 3 T3-01/02；M07）
// - Tauri：走 @tauri-apps/plugin-sql（DB 文件落在应用配置目录，WAL + 外键开启）
// - Node（dev-only / selftest / headless）：node:sqlite（DatabaseSync，内存或临时文件）
// 两种实现统一为 SqlAdapter（execute/select），调用方（core/store）无感。
// 参数风格统一用 `?` 占位 + 数组（与 Tauri plugin-sql、node:sqlite 均兼容）。

import { isTauri } from './env'

export type SqlRow = Record<string, unknown>

export interface SqlAdapter {
  /** 执行写操作（INSERT/UPDATE/DELETE/DDL）。DDL 不传 params；DML 传占位数组。 */
  execute(sql: string, params?: unknown[]): Promise<void>
  /** 查询，返回行对象数组（空结果返回 []） */
  select<T = SqlRow>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

/**
 * 创建 SQL 适配层。
 * @param dbPath Tauri：`sqlite:history.db` 这类插件路径；Node：`:memory:` 或文件路径。
 *               不传时 Tauri 默认 `sqlite:history.db`，Node 默认 `:memory:`。
 */
export async function createSqlAdapter(dbPath?: string): Promise<SqlAdapter> {
  if (isTauri()) {
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    const db = await Database.load(dbPath ?? 'sqlite:history.db')
    await db.execute('PRAGMA journal_mode = WAL')
    await db.execute('PRAGMA foreign_keys = ON')
    return {
      async execute(sql: string, params?: unknown[]): Promise<void> {
        await db.execute(sql, params ?? [])
      },
      async select<T = SqlRow>(sql: string, params?: unknown[]): Promise<T[]> {
        const rows = (await db.select(sql, params ?? [])) as unknown
        return (rows as T[]) ?? []
      },
      async close(): Promise<void> {
        await db.close()
      },
    }
  }

  // Node（dev-only）：node:sqlite
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath ?? ':memory:')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return {
    async execute(sql: string, params?: unknown[]): Promise<void> {
      if (params && params.length > 0) {
        db.prepare(sql).run(...(params as Array<number | string | bigint | null>))
      } else {
        db.exec(sql)
      }
    },
    async select<T = SqlRow>(sql: string, params?: unknown[]): Promise<T[]> {
      const stmt = db.prepare(sql)
      const rows = params && params.length > 0
        ? stmt.all(...(params as Array<number | string | bigint | null>))
        : stmt.all()
      return (rows as T[]) ?? []
    },
    async close(): Promise<void> {
      db.close()
    },
  }
}

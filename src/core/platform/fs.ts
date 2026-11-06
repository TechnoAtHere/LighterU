// platform · 文件 IO 抽象（T1-11/T1-13 落盘、T1-01 壳文件读取）
// - Tauri：走 Rust 命令 lu_read_file / lu_write_file / lu_ensure_dir / lu_exists
//   （Rust 侧用 std::fs + Win32 长路径前缀，规避 fs 插件 scope 限制，支持任意用户目录）
// - Node（dev-only）：node:fs/promises，同样做长路径前缀

import { BmuError } from '../client/errors'
import { isTauri } from './env'
import { toLongPath } from './longpath'

export interface DirEntry {
  name: string
  isDir: boolean
}

export interface FsAdapter {
  readFileBytes(path: string): Promise<Uint8Array>
  writeFileBytes(path: string, data: Uint8Array): Promise<void>
  ensureDir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** 列出目录条目（T2-07 扫图；不递归，递归由调用方控制深度） */
  readDir(path: string): Promise<DirEntry[]>
  /** 文件大小（字节）；用于读取前上限校验，避免超大文件整体入内存（可选，测试替身可不实现） */
  stat?(path: string): Promise<{ size: number }>
  /** D-99：递归删除目录（清理 DOCX 已内嵌的 images/ 等中间产物）；可选，未实现则跳过清理 */
  removeDir?(path: string): Promise<void>
}

/** invoke 返回值 → Uint8Array（tauri::ipc::Response 到达前端可能为 ArrayBuffer / Uint8Array / Response 形态） */
async function toUint8Array(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  const maybe = data as { arrayBuffer?: () => Promise<ArrayBuffer> } | null
  if (maybe !== null && typeof maybe?.arrayBuffer === 'function') {
    return new Uint8Array(await maybe.arrayBuffer())
  }
  throw new BmuError('internal', `无法解析文件读取结果：${typeof data}`)
}

const tauriFs: FsAdapter = {
  async readFileBytes(path: string): Promise<Uint8Array> {
    const { invoke } = await import('@tauri-apps/api/core')
    const data = await invoke<unknown>('lu_read_file', { path })
    return toUint8Array(data)
  },
  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('lu_write_file', { path, data })
  },
  async ensureDir(path: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('lu_ensure_dir', { path })
  },
  async exists(path: string): Promise<boolean> {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<boolean>('lu_exists', { path })
  },
  async readDir(path: string): Promise<DirEntry[]> {
    const { invoke } = await import('@tauri-apps/api/core')
    const entries = await invoke<Array<[string, boolean]>>('lu_read_dir', { path })
    return entries.map(([name, isDir]) => ({ name, isDir }))
  },
  async stat(path: string): Promise<{ size: number }> {
    const { invoke } = await import('@tauri-apps/api/core')
    const size = await invoke<number>('lu_file_size', { path })
    return { size }
  },
  async removeDir(path: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('lu_remove_dir', { path })
  },
}

async function loadNodeFs(): Promise<typeof import('node:fs/promises')> {
  const specifier = 'node:fs/promises'
  return import(/* @vite-ignore */ specifier)
}

const nodeFs: FsAdapter = {
  async readFileBytes(path: string): Promise<Uint8Array> {
    const fs = await loadNodeFs()
    return new Uint8Array(await fs.readFile(toLongPath(path)))
  },
  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    const fs = await loadNodeFs()
    await fs.mkdir(dirnameOf(toLongPath(path)), { recursive: true })
    await fs.writeFile(toLongPath(path), data)
  },
  async ensureDir(path: string): Promise<void> {
    const fs = await loadNodeFs()
    await fs.mkdir(toLongPath(path), { recursive: true })
  },
  async exists(path: string): Promise<boolean> {
    const fs = await loadNodeFs()
    try {
      await fs.access(toLongPath(path))
      return true
    } catch {
      return false
    }
  },
  async readDir(path: string): Promise<DirEntry[]> {
    const fs = await loadNodeFs()
    const entries = await fs.readdir(toLongPath(path), { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
  },
  async stat(path: string): Promise<{ size: number }> {
    const fs = await loadNodeFs()
    const s = await fs.stat(toLongPath(path))
    return { size: s.size }
  },
  async removeDir(path: string): Promise<void> {
    const fs = await loadNodeFs()
    await fs.rm(toLongPath(path), { recursive: true, force: true })
  },
}

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx > 0 ? path.slice(0, idx) : '.'
}

export function createFsAdapter(): FsAdapter {
  if (isTauri()) return tauriFs
  return nodeFs
}

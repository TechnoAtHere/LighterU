// platform · 非密配置持久化
// - Tauri：Tauri store 插件（lu-config.json，明文 JSON，仅非密配置）
// - Node（dev-only）：JSON 文件（LU_CONFIG_FILE 或 ./lu-config.json）
// 密钥绝不走此适配器（D-19/F-17）——密钥见 secrets.ts。

import { isTauri } from './env'
import { nodeEnv } from './env'

export interface ConfigStore {
  read(): Promise<Record<string, unknown> | null>
  write(data: Record<string, unknown>): Promise<void>
}

const tauriConfigStore: ConfigStore = {
  async read(): Promise<Record<string, unknown> | null> {
    const { Store } = await import('@tauri-apps/plugin-store')
    const store = await Store.load('lu-config.json')
    const value = await store.get<Record<string, unknown>>('config')
    return value ?? null
  },
  async write(data: Record<string, unknown>): Promise<void> {
    const { Store } = await import('@tauri-apps/plugin-store')
    const store = await Store.load('lu-config.json')
    await store.set('config', data)
    await store.save()
  },
}

/** Node 环境配置文件路径（dev-only） */
export function nodeConfigPath(): string {
  return nodeEnv('LU_CONFIG_FILE') ?? './lu-config.json'
}

const nodeConfigStore: ConfigStore = {
  async read(): Promise<Record<string, unknown> | null> {
    const specifier = 'node:fs/promises'
    const fs = await import(/* @vite-ignore */ specifier)
    try {
      const text = await fs.readFile(nodeConfigPath(), 'utf-8')
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  },
  async write(data: Record<string, unknown>): Promise<void> {
    const specifier = 'node:fs/promises'
    const fs = await import(/* @vite-ignore */ specifier)
    await fs.writeFile(nodeConfigPath(), JSON.stringify(data, null, 2), 'utf-8')
  },
}

export function createConfigStore(): ConfigStore {
  return isTauri() ? tauriConfigStore : nodeConfigStore
}

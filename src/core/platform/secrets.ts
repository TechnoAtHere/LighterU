// platform · 密钥存取（D-19 / F-17：Tauri store + 加密，不明文落盘）
// - Tauri：值经 Rust 命令 lu_protect_secret（Windows DPAPI，用户+机器绑定）加密为 base64  blob，
//   存入 Tauri store 插件（lu-secrets.json）——落盘即密文；读取时 lu_unprotect_secret 解密。
//   （tauri-plugin-store 本身无加密能力，加密层由 DPAPI 提供；plan/00 O-01 的 DPAPI 封装由此落地。）
// - Node（dev-only 无头入口）：从环境变量读，不落盘、不持久化。

import { BmuError } from '../client/errors'
import { isTauri } from './env'
import { nodeEnv } from './env'

export interface SecretsAdapter {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** 规范化的密钥键名（对应 plan/02 T1-04 键集） */
export const SECRET_KEYS = {
  mineruToken: 'mineru.token',
  multimodalApiKey: 'multimodal.api_key',
} as const

function envNameFor(key: string): string {
  return 'LU_SECRET_' + key.replace(/[.\-]/g, '_').toUpperCase()
}

const nodeSecrets: SecretsAdapter = {
  async get(key: string): Promise<string | null> {
    return nodeEnv(envNameFor(key)) ?? null
  },
  async set(): Promise<void> {
    throw new BmuError('internal', 'Node 环境下密钥仅支持环境变量注入（dev-only），不支持持久化。')
  },
  async delete(): Promise<void> {
    // 环境变量无法在进程内删除；无操作
  },
}

const tauriSecrets: SecretsAdapter = {
  async get(key: string): Promise<string | null> {
    const { Store } = await import('@tauri-apps/plugin-store')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = await Store.load('lu-secrets.json')
    const blob = await store.get<string>(key)
    if (typeof blob !== 'string' || blob === '') return null
    return invoke<string>('lu_unprotect_secret', { blob })
  },
  async set(key: string, value: string): Promise<void> {
    const { Store } = await import('@tauri-apps/plugin-store')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = await Store.load('lu-secrets.json')
    const blob = await invoke<string>('lu_protect_secret', { plaintext: value })
    await store.set(key, blob)
    await store.save()
  },
  async delete(key: string): Promise<void> {
    const { Store } = await import('@tauri-apps/plugin-store')
    const store = await Store.load('lu-secrets.json')
    await store.delete(key)
    await store.save()
  },
}

export function createSecretsAdapter(): SecretsAdapter {
  return isTauri() ? tauriSecrets : nodeSecrets
}

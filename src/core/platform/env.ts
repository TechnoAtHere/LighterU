// 运行时环境探测：Tauri WebView / Node（dev-only 无头入口）/ 纯浏览器
// 供 platform 适配器选择后端；不包含任何业务逻辑。

import { isTauri as tauriIsTauri } from '@tauri-apps/api/core'

/** 是否运行在 Tauri WebView 内（生产与开发均可能为 true） */
export function isTauri(): boolean {
  try {
    return tauriIsTauri()
  } catch {
    return false
  }
}

interface NodeProcessLike {
  versions?: { node?: string }
  env?: Record<string, string | undefined>
}

/** 是否运行在 Node（tsx 无头入口 / mock server / selftest） */
export function isNode(): boolean {
  return typeof process !== 'undefined' && typeof (process as NodeProcessLike).versions?.node === 'string'
}

/** 开发模式判定：Vite 构建时 process.env.NODE_ENV 被静态替换，生产构建中恒为 false（D-24 树摇依据） */
export function isDev(): boolean {
  return process.env.NODE_ENV !== 'production'
}

export function nodeEnv(name: string): string | undefined {
  if (typeof process === 'undefined') return undefined
  return (process as NodeProcessLike).env?.[name]
}

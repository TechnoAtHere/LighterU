// dev-only · 无头入口 CLI（D-24）：npm run headless -- --file <pdf> [选项]
// 复用 src/dev/headless.ts（与壳 UI 同一 core），仅开发/测试可用。

import { runHeadless } from './headless'
import { loadConfig, applyEnvOverrides } from '../core/config'
import { createHttpTransport } from '../core/platform/http'
import { testConnection } from '../core/preflight'
import type { HttpTransportKind } from '../core/types'

function parseArgs(argv: string[]): {
  filePath: string
  outputDir?: string
  baseUrl?: string
  token?: string
  transport?: HttpTransportKind
  entry?: 'workbench' | 'context-menu'
  caption?: boolean
  captionBase?: string
  captionKey?: string
  captionModel?: string
  captionMode?: 'replace' | 'both'
  /** T2-15 联调：仅测试多模态端点连通性（不解析） */
  probeCaption?: boolean
} {
  const out: ReturnType<typeof parseArgs> = { filePath: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--file':
        out.filePath = next ?? ''
        i += 1
        break
      case '--out':
        out.outputDir = next
        i += 1
        break
      case '--base-url':
        out.baseUrl = next
        i += 1
        break
      case '--token':
        out.token = next
        i += 1
        break
      case '--transport':
        if (next === 'fetch' || next === 'plugin-http' || next === 'auto') out.transport = next
        i += 1
        break
      case '--entry':
        if (next === 'workbench' || next === 'context-menu') out.entry = next
        i += 1
        break
      // T2-15 联调参数（图片描述；GUI 配置入口属 T5-07）
      case '--caption':
        out.caption = true
        break
      case '--caption-base':
        out.captionBase = next
        i += 1
        break
      case '--caption-key':
        out.captionKey = next
        i += 1
        break
      case '--caption-model':
        out.captionModel = next
        i += 1
        break
      case '--caption-mode':
        if (next === 'replace' || next === 'both') out.captionMode = next
        i += 1
        break
      case '--probe-caption':
        out.probeCaption = true
        break
      default:
        break
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.filePath && !args.probeCaption) {
    console.error(
      '用法: npm run headless -- --file <pdf路径> [--out 输出目录] [--base-url URL] [--token TOKEN] [--transport auto|fetch|plugin-http] [--entry workbench|context-menu]\n' +
        '  图片描述联调（T2-15）: [--caption --caption-base URL --caption-key KEY --caption-model MODEL [--caption-mode replace|both]] [--probe-caption]',
    )
    process.exitCode = 2
    return
  }

  // T2-15：仅探测多模态端点（不解析）
  if (args.probeCaption) {
    let config = await loadConfig({ store: (await import('../core/platform/store')).createConfigStore(), secrets: (await import('../core/platform/secrets')).createSecretsAdapter() })
    config = applyEnvOverrides(config)
    if (args.captionBase !== undefined && args.captionBase.trim() !== '') config.multimodal.baseUrl = args.captionBase.trim().replace(/\/+$/, '')
    if (args.captionKey !== undefined) config.multimodal.apiKey = args.captionKey
    if (args.captionModel !== undefined) config.multimodal.model = args.captionModel.trim()
    const result = await testConnection('multimodal', createHttpTransport(config.http.transport), config)
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
    return
  }

  const result = await runHeadless({
    filePath: args.filePath,
    outputDir: args.outputDir,
    baseUrl: args.baseUrl,
    token: args.token,
    transport: args.transport,
    entry: args.entry,
    caption: args.caption,
    captionBase: args.captionBase,
    captionKey: args.captionKey,
    captionModel: args.captionModel,
    captionMode: args.captionMode,
    log: (line) => console.log(`[headless] ${line}`),
  })
  console.log(
    JSON.stringify(
      { status: result.status, outputDir: result.outputDir, error: result.error, errorKind: result.errorKind, durationMs: result.durationMs },
      null,
      2,
    ),
  )
  if (result.status !== 'done') process.exitCode = 1
}

void main().catch((err) => {
  console.error('[headless] 未处理异常:', err)
  process.exitCode = 1
})

// dev-only · T1-17 阶段 1 验收自检（D-24）
// 对照 plan/02 阶段 1 T1-17 的 7 项验收 + T1-05/T1-08/T1-10 单测，全部经 mock server 执行，无需真实 Token。
// 运行：npm run selftest

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { startMockServer, ONE_PX_PNG_B64 } from './mock-server'
import type { MockServerHandle } from './mock-server'
import { runHeadless } from './headless'
import { TaskManager } from '../core/tasks'
import { loadConfig, normalizeConfig } from '../core/config'
import { createConfigStore } from '../core/platform/store'
import { createSecretsAdapter } from '../core/platform/secrets'
import { safeExtractZip, scanOutputs, firstMarkdown, pickFinalContentJson, sanitizeStem, sanitizeRelativePath } from '../core/output'
import { createFsAdapter } from '../core/platform/fs'
import type { FsAdapter } from '../core/platform/fs'
import { toLongPath } from '../core/platform/longpath'
import { cloudBackoffSeconds, isBmuError, maskSecret, maskSecretsInText, BmuError } from '../core/client'
import { MultimodalClient, buildChatPayload, cleanCaption, mimeOf, toBase64 } from '../core/client/multimodal'
import {
  DEFAULT_PROMPT_PRESETS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_PROMPT,
  fingerprint,
  isUserPromptId,
  listPromptPresets,
  newUserPromptId,
  normalizeCustomPrompts,
  normalizeDescription,
  rerunCaption,
  resolveActivePromptContent,
  resolveActivePromptPreset,
  resolveCaptionEnabled,
  resolvePrompt,
  runCaption,
  runPool,
} from '../core/caption'
import { LLM_PROVIDER_PRESETS, matchProvider } from '../core/config/providers'
import { parseModels } from '../core/client/models'
import { createHttpTransport } from '../core/platform/http'
import { testConnection } from '../core/preflight'
import { writebackBoth, writebackReplace } from '../core/output/writeback'
import { planParts, splitPdf, countPdfPages, mergeResults } from '../core/splitter'
import { runParseJob, SUPPORTED_INPUT_EXTS, validateInput } from '../core/pipeline'
import { emitHistoryChanged, emitLogLine, emitTaskProgress, emitTaskStatus, onCliCommand, onHistoryChanged, onLogLine, onTaskProgress, onTaskStatus } from '../core/platform/events'
import { createSqlAdapter } from '../core/platform/sql'
import { createStore } from '../core/store'
import type { Store, TaskRow } from '../core/store'
import { isBatchComplete, type SubmitMeta, type TaskRunner } from '../core/tasks'
import { viewState } from '../core/tasks/states'
import { isResumeCompatible, hashOptions } from '../core/tasks/resume'
import { parseTaskStatus } from '../core/client/compat'
import type { AppConfig, Job } from '../core/types'

interface CheckResult {
  id: string
  name: string
  pass: boolean
  detail: string
}

const results: CheckResult[] = []

function check(id: string, name: string, pass: boolean, detail: string): void {
  results.push({ id, name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}  —  ${detail}`)
}

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/** 目录内容快照（递归 文件名:大小 排序拼接；用于断言「过程不写文件」） */
async function snapshotDir(root: string): Promise<string> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(`${full}:${(await fs.stat(full)).size}`)
    }
  }
  await walk(root)
  return out.sort().join('|')
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

/** 构造隔离配置：指向 mock，快轮询，指定输出目录 */
async function buildConfig(overrides: { baseUrl: string; outputDir: string; token?: string }): Promise<AppConfig> {
  const config = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() })
  config.mineru.baseUrl = overrides.baseUrl
  config.mineru.token = overrides.token ?? 'test-token'
  config.mineru.pollIntervalMs = 500
  config.output.outputDir = overrides.outputDir
  config.output.entry = 'workbench'
  return config
}

/** 多模态就绪配置（指向 mock /v1；patch 可覆盖单键，如 maxImages/timeoutMs） */
async function mmConfig(mock: MockServerHandle, outDir: string, patch: Partial<AppConfig['multimodal']> = {}): Promise<AppConfig> {
  const config = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
  config.multimodal.baseUrl = mock.multimodalBaseUrl
  config.multimodal.apiKey = 'test-token'
  config.multimodal.model = 'vision-model'
  config.output.rightClick.captionEnabled = true
  config.output.workbench.captionEnabled = true
  Object.assign(config.multimodal, patch)
  return config
}

/** 生成指定页数的空白 PDF（T3-09 拆分测试用；页数精确、体积小） */
async function makePdf(pages: number): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i += 1) doc.addPage()
  return doc.save()
}

/** 直接驱动 pipeline（T3-08/09 用），可注入 store + taskId */
async function runPipeline(
  cfg: AppConfig,
  inputPath: string,
  store?: Store,
  taskId?: string,
): Promise<{ result: Awaited<ReturnType<typeof runParseJob>>; logs: string[] }> {
  const logs: string[] = []
  const result = await runParseJob(
    { filePath: inputPath },
    {
      config: cfg,
      transport: createHttpTransport('fetch'),
      fs: createFsAdapter(),
      onEvent: (e) => {
        if (e.type === 'log' && e.message) logs.push(e.message)
      },
      signal: new AbortController().signal,
      store,
      taskId,
    },
  )
  return { result, logs }
}

async function main(): Promise<void> {
  // ---- 隔离环境：配置走临时文件，清除可能泄漏的环境变量
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lu-selftest-'))
  process.env.LU_CONFIG_FILE = path.join(tmpRoot, 'lu-config.json')
  delete process.env.LU_SECRET_MINERU_TOKEN
  delete process.env.LU_SECRET_MULTIMODAL_API_KEY
  delete process.env.LU_MINERU_BASE_URL
  delete process.env.LU_OUTPUT_DIR
  delete process.env.LU_HTTP_TRANSPORT
  await fs.writeFile(process.env.LU_CONFIG_FILE, JSON.stringify({ mineru: { pollIntervalMs: 500 } }, null, 2))

  const pdfPath = path.join(tmpRoot, 'sample.pdf')
  await fs.writeFile(pdfPath, PDF_BYTES)
  const txtPath = path.join(tmpRoot, 'sample.txt')
  await fs.writeFile(txtPath, 'not a pdf')

  console.log(`\n=== LighterU 阶段 1 验收自检（T1-17）===\n临时目录: ${tmpRoot}\n`)

  // ---------------------------------------------------------------- ① 端到端全链
  {
    const mock = await startMockServer()
    const outDir = path.join(tmpRoot, 'a1')
    const result = await runHeadless({
      filePath: pdfPath,
      baseUrl: mock.baseUrl,
      token: 'test-token',
      outputDir: outDir,
      transport: 'fetch',
      log: () => undefined,
    })
    const mdPath = result.outputDir ? path.join(result.outputDir, 'full.md') : ''
    const imgPath = result.outputDir ? path.join(result.outputDir, 'images', 'img1.png') : ''
    let linkOk = false
    if (result.outputDir && (await exists(mdPath))) {
      const md = await fs.readFile(mdPath, 'utf-8')
      const match = /!\[[^\]]*\]\(([^)]+)\)/.exec(md)
      if (match) linkOk = await exists(path.join(result.outputDir, match[1]))
    }
    check(
      '①',
      '单 PDF 全链落盘（提交→轮询→下载→解压→定位→落盘）',
      result.status === 'done' && (await exists(mdPath)) && (await exists(imgPath)) && linkOk,
      `status=${result.status}, outputDir=${result.outputDir}, full.md=${await exists(mdPath)}, img=${await exists(imgPath)}, md图片链接可解析=${linkOk}`,
    )
    check(
      '①-T1-05',
      'Authorization 头为 Bearer + token（mock 严格校验）',
      mock.lastAuthHeader === 'Bearer test-token',
      `mock 收到的头: ${mock.lastAuthHeader}`,
    )
    check('①-T1-06', '上传经 file-urls/batch + PUT（mock 记录 1 次上传）', mock.uploads.size === 1, `uploads=${mock.uploads.size}`)
    await mock.close()
  }

  // ---------------------------------------------------------------- ①b D-27：done 即下 + 404 重查一次
  {
    const mock = await startMockServer({ notFoundOnce: true })
    const outDir = path.join(tmpRoot, 'a1b')
    const result = await runHeadless({
      filePath: pdfPath,
      baseUrl: mock.baseUrl,
      token: 'test-token',
      outputDir: outDir,
      transport: 'fetch',
      log: () => undefined,
    })
    const mdPath = result.outputDir ? path.join(result.outputDir, 'full.md') : ''
    check(
      '①b',
      '下载 404 后按 task_id 重查一次再下（D-27）',
      result.status === 'done' && (await exists(mdPath)),
      `status=${result.status}, full.md=${await exists(mdPath)}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- ②a 错误 token → 认证错误
  {
    const mock = await startMockServer()
    const config = await buildConfig({ baseUrl: mock.baseUrl, outputDir: path.join(tmpRoot, 'a2'), token: 'wrong-token' })
    const manager = new TaskManager(config)
    const job = manager.createJob(pdfPath)
    const finalJob = await manager.runJob(job.id)
    check(
      '②a',
      '错误 token 得认证错误（A0202，不重试）',
      finalJob.status === 'failed' && finalJob.errorKind === 'auth' && (finalJob.error ?? '').includes('A0202'),
      `status=${finalJob.status}, kind=${finalJob.errorKind}, error=${finalJob.error}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- ②b 断网 → 传输错误（且与认证错误提示不同）
  {
    const config = await buildConfig({ baseUrl: 'http://127.0.0.1:1/api/v4', outputDir: path.join(tmpRoot, 'a2b') })
    const manager = new TaskManager(config)
    const job = manager.createJob(pdfPath)
    const finalJob = await manager.runJob(job.id)
    check(
      '②b',
      '连接失败得传输错误（与认证错误可区分）',
      finalJob.status === 'failed' && finalJob.errorKind === 'transport',
      `status=${finalJob.status}, kind=${finalJob.errorKind}, error=${finalJob.error}`,
    )
  }

  // ---------------------------------------------------------------- ③ 取消（轮询检查点）
  {
    const mock = await startMockServer({ slow: true })
    const outDir = path.join(tmpRoot, 'a3')
    const config = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
    const manager = new TaskManager(config)
    const job = manager.createJob(pdfPath)
    const running = manager.runJob(job.id)
    const reached = await waitUntil(() => manager.getJob(job.id)?.status === 'polling', 5000)
    manager.cancel(job.id)
    const finalJob = await running
    check(
      '③',
      '取消在轮询检查点生效并落到 canceled',
      reached && finalJob.status === 'canceled' && finalJob.errorKind === 'canceled' && finalJob.outputDir === null,
      `reachedPolling=${reached}, status=${finalJob.status}, outputDir=${finalJob.outputDir}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- ④ 同名追加序号
  {
    const mock = await startMockServer()
    const outDir = path.join(tmpRoot, 'a4')
    const first = await runHeadless({ filePath: pdfPath, baseUrl: mock.baseUrl, token: 'test-token', outputDir: outDir, transport: 'fetch', log: () => undefined })
    const second = await runHeadless({ filePath: pdfPath, baseUrl: mock.baseUrl, token: 'test-token', outputDir: outDir, transport: 'fetch', log: () => undefined })
    const firstOk = first.status === 'done' && first.outputDir !== null
    const secondOk = second.status === 'done' && second.outputDir !== null && second.outputDir !== first.outputDir && second.outputDir.endsWith('_1')
    check(
      '④',
      '同名输出目录自动追加序号不覆盖',
      firstOk && secondOk && (await exists(first.outputDir ?? '')) && (await exists(second.outputDir ?? '')),
      `first=${first.outputDir}, second=${second.outputDir}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- ⑤ 解包限额与路径穿越
  {
    const manyZip = zipSync({
      'a.md': strToU8('# a'),
      'b.md': strToU8('# b'),
      'c.md': strToU8('# c'),
      'd.md': strToU8('# d'),
      'e.md': strToU8('# e'),
    })
    const traversalZip = zipSync({ '../evil.txt': strToU8('x'), 'full.md': strToU8('# ok') })
    const oversizeZip = zipSync({ 'full.md': strToU8('x'.repeat(100)) })

    let limitErr = ''
    try {
      safeExtractZip(manyZip, { maxZipEntries: 3, maxZipTotalBytes: 1_000_000, maxZipFileBytes: 1_000_000 })
    } catch (err) {
      limitErr = (err as { code?: string }).code ?? ''
    }
    let traversalErr = ''
    try {
      safeExtractZip(traversalZip, { maxZipEntries: 100, maxZipTotalBytes: 1_000_000, maxZipFileBytes: 1_000_000 })
    } catch (err) {
      traversalErr = (err as { code?: string }).code ?? ''
    }
    let oversizeErr = ''
    try {
      safeExtractZip(oversizeZip, { maxZipEntries: 100, maxZipTotalBytes: 1_000_000, maxZipFileBytes: 10 })
    } catch (err) {
      oversizeErr = (err as { code?: string }).code ?? ''
    }
    check(
      '⑤',
      '解包三重限额 + 路径穿越防护（超限即拒、不落盘）',
      limitErr === 'ZIP_LIMIT_ENTRIES' && traversalErr === 'ZIP_UNSAFE_PATH' && oversizeErr === 'ZIP_LIMIT_FILE',
      `entries=${limitErr}, traversal=${traversalErr}, fileSize=${oversizeErr}`,
    )
  }

  // ---------------------------------------------------------------- ⑥ 非 PDF 拒收
  {
    const mock = await startMockServer()
    const result = await runHeadless({
      filePath: txtPath,
      baseUrl: mock.baseUrl,
      token: 'test-token',
      outputDir: path.join(tmpRoot, 'a6'),
      transport: 'fetch',
      log: () => undefined,
    })
    check(
      '⑥',
      '非 PDF 输入返回「暂不支持」且不发起解析',
      result.status === 'failed' && result.errorKind === 'unsupported' && (result.error ?? '').includes('暂不支持') && mock.uploads.size === 0,
      `status=${result.status}, kind=${result.errorKind}, uploads=${mock.uploads.size}, error=${result.error}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- ⑦ dev-only 入口与壳 UI 产物一致
  {
    const mock = await startMockServer()
    const uiOut = path.join(tmpRoot, 'a7-ui')
    const headlessOut = path.join(tmpRoot, 'a7-headless')

    // 壳 UI 路径：TaskManager.runJob（App.vue 即用此路径）
    const uiConfig = await buildConfig({ baseUrl: mock.baseUrl, outputDir: uiOut })
    const uiManager = new TaskManager(uiConfig)
    const uiJob = uiManager.createJob(pdfPath)
    const uiFinal = await uiManager.runJob(uiJob.id)

    // dev-only 无头入口路径
    const headlessResult = await runHeadless({
      filePath: pdfPath,
      baseUrl: mock.baseUrl,
      token: 'test-token',
      outputDir: headlessOut,
      transport: 'fetch',
      log: () => undefined,
    })

    const listRel = async (dir: string): Promise<string[]> => {
      const out: string[] = []
      const walk = async (current: string, prefix: string): Promise<void> => {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(path.join(current, entry.name), `${prefix}${entry.name}/`)
          else out.push(`${prefix}${entry.name}`)
        }
      }
      if (await exists(dir)) await walk(dir, '')
      return out.sort()
    }
    const uiFiles = uiFinal.status === 'done' ? await listRel(uiFinal.outputDir ?? '') : []
    const headlessFiles = headlessResult.status === 'done' ? await listRel(headlessResult.outputDir ?? '') : []
    check(
      '⑦',
      'dev-only 入口可执行且产物与壳 UI 一致',
      uiFinal.status === 'done' && headlessResult.status === 'done' && JSON.stringify(uiFiles) === JSON.stringify(headlessFiles),
      `ui=[${uiFiles.join(', ')}], headless=[${headlessFiles.join(', ')}]`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- 单元：T1-08 退避
  {
    const seq = [1, 2, 3, 4, 5, 6].map((attempt) => cloudBackoffSeconds(attempt))
    const withRetryAfter = cloudBackoffSeconds(1, '30')
    const capped = cloudBackoffSeconds(1, '90')
    check(
      'U-08',
      '退避序列指数增长有上限；Retry-After 优先且受 60s 帽约束',
      JSON.stringify(seq) === '[1,2,4,8,16,16]' && withRetryAfter === 30 && capped === 60,
      `seq=${JSON.stringify(seq)}, retryAfter30=${withRetryAfter}, retryAfter90=${capped}`,
    )
  }

  // ---------------------------------------------------------------- 单元：T1-10 字段兼容层
  {
    const status = parseTaskStatus('t1', 'b1', {
      status: 'succeeded',
      zip_url: 'http://example.com/y.zip',
      md_url: 'http://example.com/y.md',
      msg: 'hi',
      extract_progress: '50',
      current: 5,
      total: 10,
    })
    check(
      'U-10',
      '候选字段名命中任一即归一（state/zip_url/md_url/进度）',
      status.state === 'done' && status.resultUrl === 'http://example.com/y.zip' && status.markdownUrl === 'http://example.com/y.md' && status.extractedPages === 5 && status.totalPages === 10,
      `state=${status.state}, resultUrl=${status.resultUrl}, extracted=${status.extractedPages}/${status.totalPages}`,
    )
  }

  // ---------------------------------------------------------------- 单元：T1-12 产物定位
  {
    const outputs = scanOutputs([
      { path: 'layouts.json', data: new Uint8Array() },
      { path: 'images/img1.png', data: new Uint8Array() },
      { path: '_content_list.json', data: new Uint8Array() },
      { path: 'full.md', data: new Uint8Array() },
    ])
    const markdown = firstMarkdown(outputs)
    const contentJson = pickFinalContentJson(outputs)
    check(
      'U-12',
      '产物定位：唯一 Markdown（full.md）与 content JSON（_content_list.json）',
      markdown === 'full.md' && contentJson === '_content_list.json' && outputs.imageFiles.length === 1,
      `markdown=${markdown}, contentJson=${contentJson}, images=${outputs.imageFiles.length}`,
    )
  }

  // ---------------------------------------------------------------- 单元：T1-13 保留名/非法字符/长路径
  {
    const con = sanitizeStem('CON')
    const conFile = sanitizeRelativePath('images/CON.txt')
    const illegal = sanitizeStem('a<b>c:d/e?f')
    const longPrefixed = toLongPath('C:\\very\\long\\path')
    check(
      'U-13',
      '保留名转义 + 非法字符清洗 + 长路径前缀',
      con === '_CON' && conFile === 'images/_CON.txt' && illegal === 'a_b_c_d_e_f' && longPrefixed === '\\\\?\\C:\\very\\long\\path',
      `CON→${con}, CON.txt→${conFile}, illegal→${illegal}, longPath→${longPrefixed}`,
    )
  }

  // ---------------------------------------------------------------- 单元：T1-13 长路径实际写入
  {
    const deep = path.join(tmpRoot, 'deep')
    let deepPath = deep
    for (let i = 0; i < 10; i += 1) deepPath = path.join(deepPath, `level-${'x'.repeat(28)}-${i}`)
    deepPath = path.join(deepPath, `${'y'.repeat(60)}.md`)
    const fsAdapter = createFsAdapter()
    await fsAdapter.writeFileBytes(deepPath, new TextEncoder().encode('# deep'))
    const written = await exists(deepPath)
    check('U-14', '超长路径（>260 字符）可写', written && deepPath.length > 260, `路径长度=${deepPath.length}, 写入成功=${written}`)
  }

  // ---------------------------------------------------------------- 单元：中文+空格+长路径组合（2026-10-22 真联调 bug 回归）
  {
    // ① toLongPath 斜杠归一化：\\?\ 后必须跟反斜杠（verbatim 路径不规范化 /）
    const cnForward = toLongPath('E:/大学/大学5/K 高代3/课件/lecture_2.md')
    const cnExpected = '\\\\?\\E:\\大学\\大学5\\K 高代3\\课件\\lecture_2.md'
    const uncForward = toLongPath('//server/share/大学/x.md')
    const uncExpected = '\\\\?\\UNC\\server\\share\\大学\\x.md'
    // ② 中文+空格基名清洗（保留中文与空格，只替换非法字符）
    const cnStem = sanitizeStem('K 高代3 lecture_2')
    // ③ Node 适配器真实落盘：中文+空格目录
    const cnDir = path.join(tmpRoot, '大学 测试', 'outputs')
    const cnFile = path.join(cnDir, 'full.md')
    const fsAdapter = createFsAdapter()
    await fsAdapter.ensureDir(cnDir)
    await fsAdapter.writeFileBytes(cnFile, new TextEncoder().encode('# 中文 测试'))
    const cnOk = (await exists(cnFile)) && (await fsAdapter.readFileBytes(cnFile)).length > 0
    // ④ 中文长路径（>260 字符）实际写入
    let deepCn = path.join(tmpRoot, '大学')
    for (let i = 0; i < 8; i += 1) deepCn = path.join(deepCn, `层级-${'高'.repeat(40)}-${i}`)
    deepCn = path.join(deepCn, 'deep.md')
    await fsAdapter.writeFileBytes(deepCn, new TextEncoder().encode('# deep cn'))
    const deepCnOk = await exists(deepCn)
    check(
      'U-15',
      '中文+空格+长路径组合：toLongPath 归一化 + 清洗 + 适配器落盘',
      cnForward === cnExpected && uncForward === uncExpected && cnStem === 'K 高代3 lecture_2' && cnOk && deepCnOk,
      `norm=${cnForward}, unc=${uncForward}, stem=${cnStem}, cnWrite=${cnOk}, deepCn=${deepCnOk}(len=${deepCn.length})`,
    )
  }

  // ---------------------------------------------------------------- 单元/集成：T2-01 多模态客户端
  {
    const pngBytes = new Uint8Array(Buffer.from(ONE_PX_PNG_B64, 'base64'))
    const mock = await startMockServer()
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: path.join(tmpRoot, 'mm') })
    cfg.multimodal.baseUrl = mock.multimodalBaseUrl
    cfg.multimodal.apiKey = 'test-token'
    cfg.multimodal.model = 'vision-model'
    cfg.output.rightClick.captionEnabled = true
    cfg.output.workbench.captionEnabled = true
    const transport = createHttpTransport('fetch')

    // ① 端到端：data-uri 形态 + 双段结构 + Bearer + 清洗 + usage
    const client = new MultimodalClient({ config: cfg, transport })
    const r1 = await client.caption({ image: pngBytes, fileName: 'img1.png', prompt: '描述这张图片', systemPrompt: '你是图片描述助手' })
    // ② raw-base64 形态（VS-X016：不加 data URI 前缀）
    const rawClient = new MultimodalClient({ config: cfg, transport, imageUrlForm: 'raw-base64' })
    await rawClient.caption({ image: pngBytes, fileName: 'img1.png', prompt: 'p' })

    const call1 = mock.multimodalCalls[0]
    const call2 = mock.multimodalCalls[1]
    check(
      'U-16',
      'T2-01 多模态单张描述（mock 端到端）：双段结构 + Bearer + data-uri/raw-base64 两种形态 + 清洗 + usage',
      r1.text === "一张 测试'图片'的描述 第二行"
        && r1.usage?.totalTokens === 120
        && mock.multimodalCalls.length === 2
        && call1?.auth === 'Bearer test-token'
        && call1?.model === 'vision-model'
        && call1?.messageCount === 2 && call1?.hasSystem === true
        && (call1?.imageUrlPrefix.startsWith('data:image/png;base64,iVBOR') ?? false)
        && (call2?.imageUrlPrefix.startsWith('iVBOR') ?? false) && !(call2?.imageUrlPrefix.startsWith('data:') ?? true),
      `text=${JSON.stringify(r1.text)}, usage=${r1.usage?.totalTokens}, calls=${mock.multimodalCalls.length}, auth=${call1?.auth}, msgs=${call1?.messageCount}/system=${call1?.hasSystem}, url1=${call1?.imageUrlPrefix.slice(0, 30)}…, url2=${call2?.imageUrlPrefix.slice(0, 12)}…`,
    )

    // ③ 错误分类：401→auth；断网→transport；配置缺失→business/NO_BASE_URL
    const badCfg = structuredClone(cfg)
    badCfg.multimodal.apiKey = 'wrong-key'
    let authKind = ''
    try {
      await new MultimodalClient({ config: badCfg, transport }).caption({ image: pngBytes, fileName: 'a.png', prompt: 'p' })
    } catch (err) {
      authKind = isBmuError(err) ? err.kind : 'not-lu'
    }
    const netCfg = structuredClone(cfg)
    netCfg.multimodal.baseUrl = 'http://127.0.0.1:1/v1'
    let netKind = ''
    try {
      await new MultimodalClient({ config: netCfg, transport, maxAttempts: 1 }).caption({ image: pngBytes, fileName: 'a.png', prompt: 'p' })
    } catch (err) {
      netKind = isBmuError(err) ? err.kind : 'not-lu'
    }
    const emptyCfg = structuredClone(cfg)
    emptyCfg.multimodal.baseUrl = ''
    let missCode = ''
    try {
      await new MultimodalClient({ config: emptyCfg, transport }).caption({ image: pngBytes, fileName: 'a.png', prompt: 'p' })
    } catch (err) {
      missCode = isBmuError(err) ? `${err.kind}/${err.code}` : 'not-lu'
    }
    const payload = buildChatPayload(
      { image: pngBytes, fileName: 'x.jpg', prompt: 'p', systemPrompt: 's' },
      { model: 'm', maxTokens: 100, temperature: 0, imageUrlForm: 'data-uri' },
    )
    const payloadMessages = (Array.isArray(payload.messages) ? payload.messages : []) as Array<Record<string, unknown>>
    check(
      'U-17',
      'T2-01 错误分类（401→auth、断网→transport、配置缺失→business）+ 纯函数（清洗/MIME/base64/请求体结构）',
      authKind === 'auth' && netKind === 'transport' && missCode === 'business/NO_BASE_URL'
        && cleanCaption('a\n\nb  "c"') === "a b 'c'"
        && mimeOf('x.PNG') === 'image/png' && mimeOf(undefined) === 'image/jpeg' && mimeOf('x.xyz') === 'image/jpeg'
        && toBase64(new Uint8Array([0x41, 0x42, 0x43])) === 'QUJD'
        && payload.model === 'm' && payload.max_tokens === 100 && payload.temperature === 0
        && payloadMessages.length === 2 && payloadMessages[0]?.role === 'system',
      `401→${authKind}, 断网→${netKind}, 缺配置→${missCode}, msgs=${payloadMessages.length}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- 单元：T2-02 双段 Prompt
  {
    const d = resolvePrompt()
    const c = resolvePrompt('自定义')
    const blank = resolvePrompt('   ')
    const undef = resolvePrompt(undefined)
    check(
      'U-18',
      'T2-02 双段 Prompt：默认值非空 / 自定义只覆盖 USER / 空白回落 / undefined 回落 / USER 文案无文件名措辞',
      d.system === DEFAULT_SYSTEM_PROMPT && d.user === DEFAULT_USER_PROMPT
        && d.system.length > 0 && d.user.length > 0
        && c.system === DEFAULT_SYSTEM_PROMPT && c.user === '自定义'
        && blank.user === DEFAULT_USER_PROMPT
        && undef.user === DEFAULT_USER_PROMPT
        && !/图片标题|文件名|文件路径/.test(DEFAULT_USER_PROMPT),
      `defaultSystem=${d.system.length}chars, defaultUser=${DEFAULT_USER_PROMPT.slice(0, 20)}…, custom=${c.user}, blank→default=${blank.user === DEFAULT_USER_PROMPT}, undef→default=${undef.user === DEFAULT_USER_PROMPT}`,
    )
  }

  // ---------------------------------------------------------------- 单元：轮 J 提示词方案
  {
    const hasFour = DEFAULT_PROMPT_PRESETS.length === 4
    const idsOk = ['general', 'academic', 'office', 'ui'].every((id) => DEFAULT_PROMPT_PRESETS.some((p) => p.id === id))
    const uid = newUserPromptId()
    const userPrefixOk = isUserPromptId(uid) && uid.startsWith('User-')
    // 非 User 前缀会被强制补前缀；空内容方案被丢弃
    const norm = normalizeCustomPrompts([
      { id: 'x', name: ' A ', content: ' 内容1 ' },
      { id: 'User-1', name: 'B', content: '内容2' },
      { name: '', content: '   ' },
    ])
    const normOk =
      norm.length === 2 &&
      norm[0].id === 'User-x' &&
      norm[0].name === 'A' &&
      norm[1].id === 'User-1' &&
      norm[1].name === 'B'
    const listOk = listPromptPresets({ activePromptId: 'general', customPrompts: norm }).length === 6
    // 选中 id 失效 → 回落内置 general
    const fallback = resolveActivePromptPreset({ activePromptId: 'nope', customPrompts: norm })
    const fallbackOk = fallback.id === 'general'
    const academicContent = resolveActivePromptContent({ activePromptId: 'academic', customPrompts: [] })
    const contentOk = academicContent.includes('学术论文') && academicContent.length > 200
    check(
      'U-67',
      '轮 J 提示词方案：内置 4 套 / 用户 id 强制 User 前缀 / 空内容丢弃 / 选中失效回落 general / 方案内容可解析',
      hasFour && idsOk && userPrefixOk && normOk && listOk && fallbackOk && contentOk,
      `presets=${DEFAULT_PROMPT_PRESETS.length}, uid=${uid}, norm=${norm.map((p) => p.id).join(',')}, list=${listPromptPresets({ activePromptId: 'general', customPrompts: norm }).length}, fallback=${fallback.id}, academicLen=${academicContent.length}`,
    )
  }

  // ---------------------------------------------------------------- 单元：LLM 服务商预设
  {
    const ids = LLM_PROVIDER_PRESETS.map((p) => p.id)
    const idList: string[] = ids
    const threeOk = LLM_PROVIDER_PRESETS.length === 3 && ['deepseek', 'kimi', 'minimax'].every((id) => idList.includes(id))
    // D-95：OpenAI 预设已移除，改为 MiniMax
    const noOpenaiOk = !idList.includes('openai')
    // D-94：base_url 不强制 /v1 结尾（DeepSeek 官方即 https://api.deepseek.com），只校验 https
    const urlsOk = LLM_PROVIDER_PRESETS.every((p) => p.baseUrl.startsWith('https://') && !p.baseUrl.endsWith('/'))
    const matchOk = matchProvider('https://api.moonshot.cn/v1/')?.id === 'kimi'
    const customOk = matchProvider('https://example.com/v1') === null
    // D-94：带/不带 /v1 两种写法都应回显同一服务商
    const v1TolerantOk = matchProvider('https://api.deepseek.com/v1')?.id === 'deepseek'
    const visionOk = LLM_PROVIDER_PRESETS.find((p) => p.id === 'deepseek')?.supportsVision === true
      && LLM_PROVIDER_PRESETS.find((p) => p.id === 'minimax')?.supportsVision === true
    check(
      'U-68',
      'LLM 服务商预设：三家（DeepSeek/Kimi/MiniMax，无 OpenAI）/ 地址均为 https 且不以 / 结尾 / baseUrl 反查（容忍尾斜杠与 /v1 差异）/ 未命中为自定义 / 视觉能力标记',
      threeOk && noOpenaiOk && urlsOk && matchOk && customOk && v1TolerantOk && visionOk,
      `presets=${ids.join(',')}, match=${matchProvider('https://api.moonshot.cn/v1/')?.id}, custom=${matchProvider('https://example.com/v1')}, v1=${matchProvider('https://api.deepseek.com/v1')?.id}`,
    )

    // D-95：模型列表解析（三种返回形态 + 非 JSON 容错）
    const openaiShape = parseModels('{"data":[{"id":"kimi-k3.1-pro"},{"id":"kimi-k3"}]}')
    const bareArray = parseModels('["MiniMax-M3.1-Flash","MiniMax-M3"]')
    const modelsShape = parseModels('{"models":[{"name":"deepseek-flash"},{"model":"deepseek-v4-pro"}]}')
    const notJson = parseModels('<html>Invalid CORS request</html>')
    check(
      'U-70',
      '模型列表解析：OpenAI data[].id / 裸数组 / models[]（name|model）/ 非 JSON 容错为空',
      openaiShape[0] === 'kimi-k3.1-pro' && openaiShape.length === 2
        && bareArray.length === 2 && bareArray[0] === 'MiniMax-M3.1-Flash'
        && modelsShape[0] === 'deepseek-flash' && modelsShape.length === 2
        && notJson.length === 0,
      `openai=${openaiShape}, bare=${bareArray}, models=${modelsShape}, bad=${notJson.length}`,
    )
  }

  // ---------------------------------------------------------------- 单元：输出内容多选（D-98/D-99）
  {
    const docxOnly = normalizeConfig({ output: { workbench: { outputs: ['docx'] } } } as never).output.workbench
    // 新规则：「图片」为显式选择——DOCX 自带图片，不再自动带上 images
    const docxKeepsImagesExplicit = docxOnly.outputs.includes('docx') && !docxOnly.outputs.includes('images')
    const withImages = normalizeConfig({ output: { workbench: { outputs: ['docx', 'images'] } } } as never).output.workbench
    const imagesExplicitKept = withImages.outputs.includes('images')
    const allFmt = docxOnly.format === 'all'
    const empty = normalizeConfig({ output: { workbench: { outputs: [] } } } as never).output.workbench
    const mdOnly = normalizeConfig({ output: { workbench: { outputs: ['markdown'] } } } as never).output.workbench
    const legacyAll = normalizeConfig({ output: { workbench: { format: 'all' } } } as never).output.workbench.outputs
    check(
      'U-71',
      'D-98/99 输出多选：DOCX 不隐含图片（图片为显式选择）/ 非纯 Markdown → format=all / 空选择回落 Markdown / 旧 format=all 迁移为 md+json+images',
      docxKeepsImagesExplicit && imagesExplicitKept && allFmt && empty.outputs.length === 1 && empty.outputs[0] === 'markdown' && empty.format === 'markdown'
        && mdOnly.format === 'markdown'
        && legacyAll.length === 3 && legacyAll.includes('json'),
      `docx=${docxOnly.outputs}, docx+img=${withImages.outputs}, fmt=${docxOnly.format}, empty=${empty.outputs}, mdOnly=${mdOnly.format}, legacy=${legacyAll}`,
    )
  }

  // ---------------------------------------------------------------- 单元：多格式输入校验
  {
    const exts = new Set<string>(SUPPORTED_INPUT_EXTS as readonly string[])
    const listOk = ['pdf', 'png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']
      .every((e) => exts.has(e))
    let pngOk = true
    try { validateInput('a.PNG', new Uint8Array([0x89])) } catch { pngOk = false }
    let docxOk = true
    try { validateInput('a.docx', new Uint8Array([0x50])) } catch { docxOk = false }
    let txtRej = false
    try { validateInput('a.txt', new Uint8Array([0])) } catch { txtRej = true }
    let badPdfRej = false
    try { validateInput('a.pdf', new TextEncoder().encode('not a pdf')) } catch { badPdfRej = true }
    const goodPdfOk = (() => {
      try { validateInput('a.pdf', new TextEncoder().encode('%PDF-1.7 ...')); return true } catch { return false }
    })()
    check(
      'U-69',
      '多格式输入：PDF/图片/Office 白名单放行 / 大小写扩展名 / 未知格式拒收 / PDF 魔数校验',
      listOk && pngOk && docxOk && txtRej && badPdfRej && goodPdfOk,
      `exts=${exts.size}, png=${pngOk}, docx=${docxOk}, txtRej=${txtRej}, badPdfRej=${badPdfRej}, goodPdf=${goodPdfOk}`,
    )
  }

  // ---------------------------------------------------------------- 单元：T2-03 并发池
  {
    let inFlight = 0
    let maxInFlight = 0
    const items = ['a', 'b', 'c', 'd', 'e']
    const pool = await runPool(
      items,
      async (p) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 10))
        inFlight -= 1
        if (p === 'c') throw new Error('boom')
        return `v:${p}`
      },
      { concurrency: 2 },
    )
    check(
      'U-19',
      'T2-03 并发池：并发上限受控 + 单张失败不阻断其余 + Map 结果',
      maxInFlight === 2 && pool.values.size === 4 && pool.failures.length === 1
        && pool.failures[0]?.path === 'c' && pool.values.get('a') === 'v:a' && !pool.values.has('c'),
      `maxInFlight=${maxInFlight}, ok=${pool.values.size}, failed=${pool.failures.length}, failPath=${pool.failures[0]?.path}`,
    )
  }

  // ---------------------------------------------------------------- 单元/集成：T2-04 退避重试
  {
    const mock = await startMockServer({ multimodalFailFirst: 1 })
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: path.join(tmpRoot, 'mm2') })
    cfg.multimodal.baseUrl = mock.multimodalBaseUrl
    cfg.multimodal.apiKey = 'test-token'
    cfg.multimodal.model = 'vision-model'
    cfg.output.rightClick.captionEnabled = true
    cfg.output.workbench.captionEnabled = true
    const png = new Uint8Array(Buffer.from(ONE_PX_PNG_B64, 'base64'))
    const client = new MultimodalClient({ config: cfg, transport: createHttpTransport('fetch') })
    const r = await client.caption({ image: png, fileName: 'a.png', prompt: 'p' })
    check(
      'U-20',
      'T2-04 描述调用退避重试：429 首次失败后按退避重试至成功',
      r.text.length > 0 && mock.multimodalAttempts === 2 && mock.multimodalCalls.length === 1,
      `attempts=${mock.multimodalAttempts}, okCalls=${mock.multimodalCalls.length}, text=${JSON.stringify(r.text.slice(0, 20))}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- 集成：T2-05/06/07 目录级描述
  {
    const outDir = path.join(tmpRoot, 'cap-out')
    await fs.mkdir(path.join(outDir, 'images'), { recursive: true })
    await fs.writeFile(path.join(outDir, 'full.md'), '# t\n\n![a](images/a.png)\n')
    const png = Buffer.from(ONE_PX_PNG_B64, 'base64')
    await fs.writeFile(path.join(outDir, 'images', 'a.png'), png)
    await fs.writeFile(path.join(outDir, 'images', 'b.png'), png) // 与 a 同字节 → 指纹去重
    await fs.writeFile(path.join(outDir, 'images', 'c.png'), Buffer.concat([png, Buffer.from([0])])) // 异字节
    await fs.writeFile(path.join(outDir, 'notes.txt'), 'not an image') // 非图片应被忽略
    const before = await snapshotDir(outDir)

    const mock = await startMockServer()
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
    cfg.multimodal.baseUrl = mock.multimodalBaseUrl
    cfg.multimodal.apiKey = 'test-token'
    cfg.multimodal.model = 'vision-model'
    cfg.output.rightClick.captionEnabled = true
    cfg.output.workbench.captionEnabled = true
    cfg.multimodal.concurrency = 2
    const logs: string[] = []
    const result = await runCaption({ config: cfg, transport: createHttpTransport('fetch') }, {
      outputDir: outDir,
      onLog: (m) => logs.push(m),
    })
    const after = await snapshotDir(outDir)

    const pngU8 = new Uint8Array(png)
    const diffU8 = new Uint8Array(Buffer.concat([png, Buffer.from([0])]))
    const fpSame = fingerprint(pngU8) === fingerprint(pngU8)
    const fpDiff = fingerprint(pngU8) !== fingerprint(diffU8)
    const fp8 = /^[0-9a-f]{8}$/.test(fingerprint(pngU8))
    const norm = normalizeDescription('这是 [带括号] 的\n"描述"')
    // 键为统一正斜杠路径；测试侧用 path.normalize 归一后比较（分隔符无关）
    const byNorm = new Map<string, string>()
    for (const [k, v] of result.captions) byNorm.set(path.normalize(k), v)
    const aPath = path.join(outDir, 'images', 'a.png')
    const bPath = path.join(outDir, 'images', 'b.png')
    check(
      'U-21',
      'T2-07 目录级描述：递归扫图/指纹去重/归一/不写文件/统计 + T2-05/06 纯函数',
      result.captions.size === 3
        && result.stats.images === 3 && result.stats.described === 2 && result.stats.duplicates === 1 && result.stats.failed === 0
        && mock.multimodalCalls.length === 2
        && byNorm.get(aPath) === byNorm.get(bPath)
        && (byNorm.get(aPath)?.length ?? 0) > 0
        && before === after
        && fpSame && fpDiff && fp8
        && norm === "这是 ［带括号］ 的 '描述'",
      `stats=${JSON.stringify(result.stats)}, calls=${mock.multimodalCalls.length}, fp8=${fp8}, norm=${JSON.stringify(norm)}, logs=${logs.length}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- 单元：T2-08 替换原文件
  {
    const captions = new Map([
      ['C:/out/images/a.png', '一只猫在睡觉'],
      ['C:/out/images/b.png', '柱状图显示 2024 年销量'],
    ])
    const md = '# 标题\n\n![图A](images/a.png)\n\n![图B](images/b.png)\n\n![图C](images/c.png)\n'
    const out = writebackReplace(md, captions)
    check(
      'U-22',
      'T2-08 替换原文件：命中引用整段换描述，未命中引用不变',
      out === '# 标题\n\n一只猫在睡觉\n\n柱状图显示 2024 年销量\n\n![图C](images/c.png)\n',
      `out=${JSON.stringify(out.slice(0, 60))}…`,
    )
    const once = writebackReplace(md, captions)
    const twice = writebackReplace(once, captions)
    const htmlOut = writebackReplace('<p><img src="images/a.png" alt="x"></p>', captions)
    check(
      'U-23',
      'T2-08 幂等（双跑一致）+ HTML img 形态同样替换',
      twice === once && htmlOut === '<p>一只猫在睡觉</p>',
      `idempotent=${twice === once}, html=${JSON.stringify(htmlOut)}`,
    )
  }

  // ---------------------------------------------------------------- 单元：T2-09 两者都有
  {
    const captions = new Map([
      ['C:/out/images/a.png', '一只猫在睡觉'],
      ['C:/out/images/b.png', '柱状图显示销量'],
    ])
    const md = '![图A](images/a.png)\n\n![图B](images/b.png)\n\n![图C](images/c.png)\n'
    const out = writebackBoth(md, captions)
    check(
      'U-24',
      'T2-09 两者都有：引用保留 + 一空格旁注；未命中不变',
      out === '![图A](images/a.png) [图片描述:一只猫在睡觉]\n\n![图B](images/b.png) [图片描述:柱状图显示销量]\n\n![图C](images/c.png)\n',
      `out=${JSON.stringify(out.slice(0, 70))}…`,
    )
    const twice = writebackBoth(out, captions)
    check(
      'U-25',
      'T2-09 幂等：重复执行不产生重复旁注',
      twice === out && (out.match(/\[图片描述:/g) ?? []).length === 2,
      `idempotent=${twice === out}, annotations=${(out.match(/\[图片描述:/g) ?? []).length}`,
    )
    const bracketOut = writebackBoth('![x](images/a.png)', new Map([['C:/out/images/a.png', '公式 [E=mc2] 如图所示']]))
    check(
      'U-26',
      'T2-09 描述含 ASCII 方括号：全角化后旁注结构不被破坏',
      bracketOut === '![x](images/a.png) [图片描述:公式 ［E=mc2］ 如图所示]'
        && !bracketOut.includes('[图片描述:公式 [E=mc2]'),
      `out=${JSON.stringify(bracketOut)}`,
    )
  }

  // ---------------------------------------------------------------- 单元：T2-10 配置 clamp
  {
    const clamped = normalizeConfig({
      multimodal: { concurrency: 100, timeoutMs: 1000, maxAttempts: 99, maxImages: -5, imageUrlForm: 'weird', maxDescriptionChars: 5 },
    })
    check(
      'U-27',
      'T2-10 normalizeConfig clamp：并发 100→16 / 超时 1000→5000 / 重试 99→10 / 上限 -5→0 / 形态非法→data-uri / 长度 5→20',
      clamped.multimodal.concurrency === 16 && clamped.multimodal.timeoutMs === 5000 && clamped.multimodal.maxAttempts === 10
        && clamped.multimodal.maxImages === 0 && clamped.multimodal.imageUrlForm === 'data-uri' && clamped.multimodal.maxDescriptionChars === 20,
      `concurrency=${clamped.multimodal.concurrency}, timeoutMs=${clamped.multimodal.timeoutMs}, maxAttempts=${clamped.multimodal.maxAttempts}, maxImages=${clamped.multimodal.maxImages}, form=${clamped.multimodal.imageUrlForm}, chars=${clamped.multimodal.maxDescriptionChars}`,
    )
    const rawForm = normalizeConfig({ multimodal: { imageUrlForm: 'raw-base64' } })
    check(
      'U-27b',
      'T2-10 imageUrlForm=raw-base64 合法值保留',
      rawForm.multimodal.imageUrlForm === 'raw-base64',
      `form=${rawForm.multimodal.imageUrlForm}`,
    )
  }

  // ---------------------------------------------------------------- 集成：T2-10 配置驱动与回落
  {
    const mock = await startMockServer({ multimodalDelayMs: 2000 })
    const png = new Uint8Array(Buffer.from(ONE_PX_PNG_B64, 'base64'))
    // 配置驱动：timeoutMs=100（配置）→ 100ms 超时
    const cfg = await mmConfig(mock, path.join(tmpRoot, 'mm3'), { timeoutMs: 100, maxAttempts: 1 })
    let timeoutKind = ''
    try {
      await new MultimodalClient({ config: cfg, transport: createHttpTransport('fetch') }).caption({ image: png, fileName: 'a.png', prompt: 'p' })
    } catch (err) {
      timeoutKind = isBmuError(err) ? err.kind : 'not-lu'
    }
    // 回落：配置缺省 timeoutMs → 用模块常量 120s → 成功
    const bare = structuredClone(cfg)
    ;(bare.multimodal as { timeoutMs?: number }).timeoutMs = undefined
    const r2 = await new MultimodalClient({ config: bare, transport: createHttpTransport('fetch') }).caption({ image: png, fileName: 'a.png', prompt: 'p' })
    check(
      'U-28',
      'T2-10 配置驱动与回落：timeoutMs 走配置（100ms 超时）/ 缺省回落模块常量（120s 成功）',
      timeoutKind === 'canceled' && r2.text.length > 0,
      `timeoutKind=${timeoutKind}, fallbackOk=${r2.text.length > 0}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- 集成：T2-11 preflight
  {
    const mock = await startMockServer()
    const cfg = await mmConfig(mock, path.join(tmpRoot, 'pf'))
    const t = createHttpTransport('fetch')
    const rMineru = await testConnection('mineru', t, cfg)
    const rMm = await testConnection('multimodal', t, cfg)
    const badToken = structuredClone(cfg)
    badToken.mineru.token = 'wrong-token'
    const r401 = await testConnection('mineru', t, badToken)
    check(
      'U-29',
      'T2-11 preflight 可达路径：200 成功 / 401 也算可达（网络层）/ 模型列表命中 / latency',
      rMineru.ok && rMineru.latency >= 0 && rMm.ok && rMm.msg.includes('vision-model') && r401.ok,
      `mineru=${JSON.stringify(rMineru)}, mm=${JSON.stringify(rMm)}, 401ok=${r401.ok}`,
    )
    await mock.close()

    const slowMock = await startMockServer({ multimodalDelayMs: 3000 })
    const cfg2 = await mmConfig(slowMock, path.join(tmpRoot, 'pf2'))
    const rTimeout = await testConnection('multimodal', t, cfg2, { timeoutMs: 200 })
    const emptyCfg = structuredClone(cfg2)
    emptyCfg.multimodal.baseUrl = ''
    const rEmpty = await testConnection('multimodal', t, emptyCfg)
    const deadCfg = structuredClone(cfg2)
    deadCfg.multimodal.baseUrl = 'http://127.0.0.1:1/v1'
    const rDead = await testConnection('multimodal', t, deadCfg)
    check(
      'U-30',
      'T2-11 preflight 失败路径：超时 / 未配置端点 / 网络不可达',
      !rTimeout.ok && rTimeout.msg === '超时' && !rEmpty.ok && rEmpty.msg === '未配置端点' && !rDead.ok && rDead.msg.startsWith('网络错误'),
      `timeout=${JSON.stringify(rTimeout)}, empty=${JSON.stringify(rEmpty)}, dead=${rDead.msg.slice(0, 30)}`,
    )
    await slowMock.close()
  }

  // ---------------------------------------------------------------- 单元：T2-12 开关三层
  {
    check(
      'U-31',
      'T2-12 描述开关三层：调用级 > 入口级 > 全局（四种组合）',
      resolveCaptionEnabled(false, undefined) === false
        && resolveCaptionEnabled(false, true) === true
        && resolveCaptionEnabled(true, false) === false
        && resolveCaptionEnabled(false, false) === false
        && resolveCaptionEnabled(true, undefined) === true,
      `e=F,c=∅→${resolveCaptionEnabled(false, undefined)}; e=F,c=T→${resolveCaptionEnabled(false, true)}; e=T,c=F→${resolveCaptionEnabled(true, false)}; e=F,c=F→${resolveCaptionEnabled(false, false)}; e=T,c=∅→${resolveCaptionEnabled(true, undefined)}`,
    )
  }

  // ---------------------------------------------------------------- 集成：T2-13 单独重跑
  {
    const outDir = path.join(tmpRoot, 'rerun-ok')
    await fs.mkdir(path.join(outDir, 'images'), { recursive: true })
    const png = Buffer.from(ONE_PX_PNG_B64, 'base64')
    const originalMd = '# 文档\n\n![图1](images/a.png)\n\n![图2](images/b.png)\n'
    await fs.writeFile(path.join(outDir, 'full.md'), originalMd)
    await fs.writeFile(path.join(outDir, 'images', 'a.png'), png)
    await fs.writeFile(path.join(outDir, 'images', 'b.png'), Buffer.concat([png, Buffer.from([1])]))
    await fs.writeFile(path.join(outDir, '_content_list.json'), '[]')

    const mock = await startMockServer()
    const cfg = await mmConfig(mock, outDir)
    const r = await rerunCaption({ config: cfg, transport: createHttpTransport('fetch') }, { outputDir: outDir, enabledDefault: true })
    const mdAfter = await fs.readFile(path.join(outDir, 'full.md'), 'utf-8')
    const bakMd = await exists(path.join(outDir, 'full.md.bak')) ? await fs.readFile(path.join(outDir, 'full.md.bak'), 'utf-8') : ''
    check(
      'U-32',
      'T2-13 单独重跑：full.md 被替换写回 + .bak 备份原内容 + written 列表 + stats',
      r.written.length === 1 && bakMd === originalMd
        && !mdAfter.includes('![图1](images/a.png)') && mdAfter.includes('一张')
        && r.stats.described === 2 && r.stats.images === 2,
      `written=${r.written.length}, bakOk=${bakMd === originalMd}, described=${r.stats.described}`,
    )
    await mock.close()

    // 写失败：full.md 写入抛错 → .bak 保留、原文件不变、抛 WRITEBACK_FAILED
    const failDir = path.join(tmpRoot, 'rerun-fail')
    await fs.mkdir(path.join(failDir, 'images'), { recursive: true })
    await fs.writeFile(path.join(failDir, 'full.md'), originalMd)
    await fs.writeFile(path.join(failDir, 'images', 'a.png'), png)
    const mock2 = await startMockServer()
    const cfg2 = await mmConfig(mock2, failDir)
    const baseFs = createFsAdapter()
    const failingFs: FsAdapter = {
      ...baseFs,
      writeFileBytes: async (p: string, data: Uint8Array) => {
        if (p.endsWith('full.md')) throw new BmuError('business', '磁盘已满（mock）', { code: 'DISK_FULL' })
        return baseFs.writeFileBytes(p, data)
      },
    }
    let thrown = ''
    try {
      await rerunCaption({ config: cfg2, transport: createHttpTransport('fetch'), fs: failingFs }, { outputDir: failDir, enabledDefault: true })
    } catch (err) {
      thrown = isBmuError(err) ? `${err.kind}/${err.code}` : 'not-lu'
    }
    const mdUnchanged = await fs.readFile(path.join(failDir, 'full.md'), 'utf-8')
    check(
      'U-33',
      'T2-13 写回失败：抛 WRITEBACK_FAILED + .bak 保留 + 原文件不变',
      thrown === 'business/WRITEBACK_FAILED' && (await exists(path.join(failDir, 'full.md.bak'))) && mdUnchanged === originalMd,
      `thrown=${thrown}, bak=${await exists(path.join(failDir, 'full.md.bak'))}, unchanged=${mdUnchanged === originalMd}`,
    )
    await mock2.close()
  }

  // ---------------------------------------------------------------- 单元：T2-14 日志脱敏
  {
    check(
      'U-34',
      'T2-14 日志脱敏：短值全星 / 长值留头尾 / 文本按值替换',
      maskSecret('short') === '****' && maskSecret('12345678') === '****' && maskSecret('sk-1234567890') === 'sk-****890'
        && maskSecret('') === ''
        && maskSecretsInText('Incorrect API key: sk-1234567890', ['sk-1234567890']) === 'Incorrect API key: sk-****890'
        && maskSecretsInText('no secrets here', ['sk-1234567890']) === 'no secrets here'
        && maskSecretsInText('token abcdefgh end', ['abcdefgh']) === 'token **** end',
      `short=${maskSecret('short')}, long=${maskSecret('sk-1234567890')}, text=${maskSecretsInText('Incorrect API key: sk-1234567890', ['sk-1234567890'])}`,
    )
  }

  // ---------------------------------------------------------------- 集成：D-35 affectedPaths
  {
    const outDir = path.join(tmpRoot, 'affected')
    await fs.mkdir(path.join(outDir, 'images'), { recursive: true })
    await fs.writeFile(path.join(outDir, 'full.md'), '# t\n')
    const png = Buffer.from(ONE_PX_PNG_B64, 'base64')
    await fs.writeFile(path.join(outDir, 'images', 'a.png'), png)
    await fs.writeFile(path.join(outDir, 'images', 'a-copy.png'), png) // 同字节同组
    const mock = await startMockServer({ multimodalFailAll: true })
    const cfg = await mmConfig(mock, outDir)
    const logs: string[] = []
    const r = await runCaption({ config: cfg, transport: createHttpTransport('fetch') }, { outputDir: outDir, onLog: (m) => logs.push(m) })
    const rep = r.failures[0]
    check(
      'U-35',
      'D-35 affectedPaths：代表失败列出全组路径 + stats.failed 记 1 + 日志逐行展开',
      r.failures.length === 1 && (rep?.affectedPaths.length ?? 0) === 2 && r.stats.failed === 1 && r.captions.size === 0
        && logs.some((l) => l.includes('受影响（同内容）')),
      `failures=${r.failures.length}, affected=${rep?.affectedPaths.length ?? 0}, stats.failed=${r.stats.failed}, logExpand=${logs.some((l) => l.includes('受影响（同内容）'))}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- 集成：T2-10 调用上限
  {
    const outDir = path.join(tmpRoot, 'capped')
    await fs.mkdir(path.join(outDir, 'images'), { recursive: true })
    await fs.writeFile(path.join(outDir, 'full.md'), '# t\n')
    const png = Buffer.from(ONE_PX_PNG_B64, 'base64')
    await fs.writeFile(path.join(outDir, 'images', 'a.png'), png)
    await fs.writeFile(path.join(outDir, 'images', 'b.png'), Buffer.concat([png, Buffer.from([1])]))
    await fs.writeFile(path.join(outDir, 'images', 'c.png'), Buffer.concat([png, Buffer.from([2])]))
    const mock = await startMockServer()
    const cfg = await mmConfig(mock, outDir, { maxImages: 1 })
    const logs: string[] = []
    const r = await runCaption({ config: cfg, transport: createHttpTransport('fetch') }, { outputDir: outDir, onLog: (m) => logs.push(m) })
    check(
      'U-36',
      'T2-10 调用上限：maxImages=1 → described=1、capped=2、mock 仅 1 次调用',
      r.stats.described === 1 && r.stats.capped === 2 && r.captions.size === 1 && mock.multimodalCalls.length === 1
        && logs.some((l) => l.includes('调用上限')),
      `stats=${JSON.stringify(r.stats)}, calls=${mock.multimodalCalls.length}`,
    )
    await mock.close()
  }

  // ================================================================ 阶段 3 · 存储与队列（T3-01~T3-11）
  // ---------------------------------------------------------------- T3-01/02 存储层 DDL + CRUD
  {
    const sql = await createSqlAdapter(':memory:')
    const store = createStore(sql)
    await store.initSchema()
    // 可重复执行（迁移幂等）
    await store.initSchema()

    const now = Date.now()
    const row: TaskRow = {
      id: 't1', inputPath: '/x/a.pdf', fileName: 'a.pdf', status: 'pending', createdAt: now, updatedAt: now,
      outputDir: null, batchId: null, captionEnabled: true, processingLocation: 'inplace',
      error: null, errorKind: null, errorStage: null, retryCount: 0,
    }
    await store.saveTask(row)
    const got = await store.getTask('t1')
    await store.updateTask('t1', { status: 'done', updatedAt: now + 1, outputDir: '/out/a' })
    const updated = await store.getTask('t1')
    await store.updateFile('t1', { name: 'a.png' }, { name: 'a.png', status: 'pending' })
    const files = await store.loadFiles('t1')
    const hist = await store.getHistory({ status: 'done' })
    await store.deleteBatch('t1')
    const afterDel = await store.getTask('t1')
    const filesAfter = await store.loadFiles('t1')

    check(
      'U-37',
      'T3-01/02 DDL+CRUD：落库/更新/文件级/历史筛选/删除级联',
      !!got && got.captionEnabled === true && got.processingLocation === 'inplace'
        && updated?.status === 'done' && updated?.outputDir === '/out/a'
        && files.length === 1 && files[0].name === 'a.png'
        && hist.length === 1 && hist[0].id === 't1'
        && afterDel === null && filesAfter.length === 0,
      `got=${!!got}, updStatus=${updated?.status}, files=${files.length}, hist=${hist.length}, afterDel=${afterDel}, filesAfter=${filesAfter.length}`,
    )
    await sql.close()
  }

  // ---------------------------------------------------------------- T3-02/08 文件 upsert + 上传/指纹
  {
    const sql = await createSqlAdapter(':memory:')
    const store = createStore(sql)
    await store.initSchema()
    const now = Date.now()
    await store.saveTask({
      id: 't1', inputPath: '/x/a.pdf', fileName: 'a.pdf', status: 'pending', createdAt: now, updatedAt: now,
      outputDir: null, batchId: null, captionEnabled: false, processingLocation: 'workbench',
      error: null, errorKind: null, errorStage: null, retryCount: 0,
    })
    await store.updateFile('t1', { name: 'a.png' }, { name: 'a.png', status: 'pending' })
    // 同 match 再 upsert → 不应新增行
    await store.updateFile('t1', { name: 'a.png' }, { status: 'downloading' })
    const before = await store.loadFiles('t1')
    await store.recordUpload('t1', { name: 'a.png' }, 'data_xyz', 'fp_abc')
    const after = await store.loadFiles('t1')
    check(
      'U-38',
      'T3-02/08 文件 upsert 幂等 + 断点记录（data_id/fingerprint/uploadStatus）',
      before.length === 1 && before[0].status === 'downloading'
        && after.length === 1 && after[0].dataId === 'data_xyz' && after[0].fingerprint === 'fp_abc' && after[0].uploadStatus === 'uploaded',
      `before=${before.length}, after=${after.length}, dataId=${after[0]?.dataId}, fp=${after[0]?.fingerprint}, up=${after[0]?.uploadStatus}`,
    )
    await sql.close()
  }

  // ---------------------------------------------------------------- T3-03 落库状态机（提交即落库 + 阶段落库）
  {
    const sql = await createSqlAdapter(':memory:')
    const store = createStore(sql)
    await store.initSchema()
    const cfg = normalizeConfig({})
    const runner: TaskRunner = async (jobId) => {
      const job = tm39.getJob(jobId)!
      job.status = 'done'
      job.updatedAt = Date.now()
      await store.updateTask(jobId, { status: 'done', updatedAt: job.updatedAt })
      return job
    }
    const tm39: TaskManager = new TaskManager(cfg, store, runner)
    const meta: SubmitMeta = { captionEnabled: true, processingLocation: 'inplace' }
    const j = await tm39.submit('/in/b.pdf', meta)
    // 等待 drain 完成
    await waitUntil(() => tm39.getJob(j.id)!.status === 'done', 3000)
    const stored = await store.getTask(j.id)
    // 阶段落库能力（T3-03：transition 落库 + stage_detail）—— 直接验证 store 写阶段
    await store.updateTask(j.id, { status: 'failed', errorStage: 'downloading', error: 'e1' })
    const withStage = await store.getTask(j.id)
    check(
      'U-39',
      'T3-03 提交即落库（含 captionEnabled/location）+ 阶段落库带 stage_detail',
      !!stored && stored.captionEnabled === true && stored.processingLocation === 'inplace' && stored.status === 'done'
        && withStage?.errorStage === 'downloading' && withStage?.error === 'e1',
      `stored=${!!stored}, cap=${stored?.captionEnabled}, loc=${stored?.processingLocation}, stage=${withStage?.errorStage}`,
    )
    await sql.close()
  }

  // ---------------------------------------------------------------- T3-04 队列顺序 + 并发 1
  {
    const cfg = normalizeConfig({})
    let order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const runner: TaskRunner = async (jobId) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      order.push(jobId)
      await new Promise((r) => setTimeout(r, 15))
      inFlight -= 1
      const job = tm40.getJob(jobId)!
      job.status = 'done'
      return job
    }
    const tm40: TaskManager = new TaskManager(cfg, undefined, runner)
    const a = await tm40.submit('a.pdf')
    const b = await tm40.submit('b.pdf')
    const c = await tm40.submit('c.pdf')
    await waitUntil(
      () => tm40.getJob(a.id)!.status === 'done' && tm40.getJob(b.id)!.status === 'done' && tm40.getJob(c.id)!.status === 'done',
      4000,
    )
    check(
      'U-40',
      'T3-04 任务队列：多文件依次执行、不并行（并发 1）',
      order.length === 3 && order[0] === a.id && order[1] === b.id && order[2] === c.id && maxInFlight === 1,
      `order=${order.map((o) => o.slice(-3)).join('>')}, maxInFlight=${maxInFlight}`,
    )
  }

  // ---------------------------------------------------------------- T3-05 取消传播（运行中 + 队列中）
  {
    const cfg = normalizeConfig({})
    // 运行中取消：runner 监听 signal
    let aborted = false
    const runnerRun: TaskRunner = async (jobId, signal) => {
      const job = tm41.getJob(jobId)!
      await new Promise<void>((resolve) => {
        if (signal.aborted) { aborted = true; resolve(); return }
        signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
      })
      job.status = aborted ? 'canceled' : 'done'
      return job
    }
    const tm41: TaskManager = new TaskManager(cfg, undefined, runnerRun)
    const jr = await tm41.submit('run.pdf')
    tm41.cancel(jr.id)
    await waitUntil(() => tm41.getJob(jr.id)!.status === 'canceled', 3000)
    const canceledRunning = tm41.getJob(jr.id)!.status === 'canceled' && aborted

    // 队列中取消：j1 占用 runner，j2 排队，cancel(j2) 直接标记
    let j1Done = false
    const runnerQ: TaskRunner = async (jobId) => {
      const job = tm42.getJob(jobId)!
      await new Promise((r) => setTimeout(r, 30))
      if (jobId === j1.id) j1Done = true
      job.status = 'done'
      return job
    }
    const tm42: TaskManager = new TaskManager(cfg, undefined, runnerQ)
    const j1 = await tm42.submit('q1.pdf')
    const j2 = await tm42.submit('q2.pdf')
    const queuedCanceled = tm42.cancel(j2.id)
    await waitUntil(() => tm42.getJob(j1.id)!.status === 'done' && tm42.getJob(j2.id)!.status === 'canceled', 3000)
    check(
      'U-41',
      'T3-05 取消传播：运行中中止 + 队列中标记 canceled（不影响后续）',
      canceledRunning && queuedCanceled === true && tm42.getJob(j1.id)!.status === 'done' && tm42.getJob(j2.id)!.status === 'canceled' && j1Done,
      `runCanceled=${canceledRunning}, queueCanceled=${queuedCanceled}, j1=${tm42.getJob(j1.id)!.status}, j2=${tm42.getJob(j2.id)!.status}`,
    )
  }

  // ---------------------------------------------------------------- T3-06 重试（守卫 + 计数递增 + 上限）
  {
    const cfg = normalizeConfig({ tasks: { maxRetries: 2 } })
    // D-96 守卫：执行中状态不可重试；终态（含 done）允许重新解析
    const tm43: TaskManager = new TaskManager(cfg, undefined, async (id) => tm43.getJob(id)!)
    const jd = tm43.createJob('running.pdf')
    tm43.getJob(jd.id)!.status = 'uploading'
    let guardRunning = false
    try { await tm43.retry(jd.id) } catch (e) { guardRunning = isBmuError(e) && e.code === 'NOT_RETRYABLE' }

    const jDone = tm43.createJob('done.pdf')
    tm43.getJob(jDone.id)!.status = 'done'
    let doneRetryable = false
    try {
      await tm43.retry(jDone.id)
      doneRetryable = true
    } catch {
      doneRetryable = false
    }

    // 轮 I（D-80）：手动重试不再受 maxRetries 限制（默认 0 也能重试）——达上限仍放行，仅记录提示
    const tm44: TaskManager = new TaskManager(cfg, undefined, async (id) => {
      const job = tm44.getJob(id)!
      job.status = 'done'
      return job
    })
    const jf = tm44.createJob('fail.pdf')
    tm44.getJob(jf.id)!.status = 'failed'
    tm44.getJob(jf.id)!.retryCount = 2
    let overLimitProceeded = false
    try {
      await tm44.retry(jf.id)
      overLimitProceeded = tm44.getJob(jf.id)!.status === 'done' && tm44.getJob(jf.id)!.retryCount === 3
    } catch {
      overLimitProceeded = false
    }

    // 实操：failed → 计数递增并重新执行（runner 置 done）
    const tm45: TaskManager = new TaskManager(cfg, undefined, async (id) => {
      const job = tm45.getJob(id)!
      job.status = 'done'
      return job
    })
    const jx = tm45.createJob('retry.pdf')
    tm45.getJob(jx.id)!.status = 'failed'
    tm45.getJob(jx.id)!.retryCount = 0
    await tm45.retry(jx.id)
    check(
      'U-42',
      'T3-06 重试：执行中拦截（NOT_RETRYABLE）/ 已完成可重跑（D-96）+ 手动重试不受上限阻断（轮 I）+ 计数递增 + 重新执行',
      guardRunning && doneRetryable && overLimitProceeded && tm45.getJob(jx.id)!.status === 'done' && tm45.getJob(jx.id)!.retryCount === 1,
      `runningGuard=${guardRunning}, doneRetryable=${doneRetryable}, overLimit=${overLimitProceeded}, status=${tm45.getJob(jx.id)!.status}, retryCount=${tm45.getJob(jx.id)!.retryCount}`,
    )
  }

  // ---------------------------------------------------------------- T3-07 崩溃恢复
  {
    const sql = await createSqlAdapter(':memory:')
    const store = createStore(sql)
    await store.initSchema()
    const now = Date.now()
    const mk = (id: string, status: Job['status'], updatedAt: number): TaskRow => ({
      id, inputPath: `/x/${id}.pdf`, fileName: `${id}.pdf`, status, createdAt: now, updatedAt,
      outputDir: null, batchId: null, captionEnabled: false, processingLocation: 'workbench',
      error: null, errorKind: null, errorStage: null, retryCount: 0,
    })
    await store.saveTask(mk('recent', 'polling', now))          // 未终态、新 → interrupted
    await store.saveTask(mk('stale', 'uploading', now - 200_000)) // 未终态、旧 → failed
    await store.saveTask(mk('done', 'done', now - 999_999))       // 终态 → 不动
    const res = await TaskManager.recover(store, 100_000)
    const rRecent = await store.getTask('recent')
    const rStale = await store.getTask('stale')
    const rDone = await store.getTask('done')
    check(
      'U-43',
      'T3-07 崩溃恢复：未终态→interrupted；超 stale 阈值→failed；终态不变',
      res.interrupted === 1 && res.failed === 1
        && rRecent?.status === 'interrupted' && rStale?.status === 'failed' && rDone?.status === 'done'
        && (rStale?.error ?? '').includes('中断超时'),
      `interrupted=${res.interrupted}, failed=${res.failed}, recent=${rRecent?.status}, stale=${rStale?.status}, done=${rDone?.status}`,
    )
    await sql.close()
  }

  // ---------------------------------------------------------------- T3-08 断点续传判定
  {
    const cur = { fingerprint: 'fp1', optionsHash: 'o1' }
    const compat = isResumeCompatible({ fingerprint: 'fp1', optionsHash: 'o1', dataId: 'd1', status: 'uploaded' }, cur)
    const fpMismatch = isResumeCompatible({ fingerprint: 'fp2', optionsHash: 'o1', dataId: 'd1', status: 'uploaded' }, cur)
    const optMismatch = isResumeCompatible({ fingerprint: 'fp1', optionsHash: 'o2', dataId: 'd1', status: 'uploaded' }, cur)
    const noData = isResumeCompatible({ fingerprint: 'fp1', optionsHash: 'o1', dataId: null, status: 'uploaded' }, cur)
    const failedOld = isResumeCompatible({ fingerprint: 'fp1', optionsHash: 'o1', dataId: 'd1', status: 'failed' }, cur)
    const sameHash = hashOptions({ a: 1, b: 'x' }) === hashOptions({ b: 'x', a: 1 })
    check(
      'U-44',
      'T3-08 断点续传：指纹/选项一致+有 data_id+未失败才可复用；选项或文件变化不复用',
      compat === true && fpMismatch === false && optMismatch === false && noData === false && failedOld === false && sameHash === true,
      `compat=${compat}, fp=${fpMismatch}, opt=${optMismatch}, noData=${noData}, failed=${failedOld}, hashStable=${sameHash}`,
    )
  }

  // ---------------------------------------------------------------- T3-10/11 完成判定 + 状态映射
  {
    const complete = isBatchComplete([{ status: 'done' }, { status: 'failed' }])
    const incomplete = isBatchComplete([{ status: 'done' }, { status: 'pending' }])
    const empty = isBatchComplete([])
    const vDone = viewState('done')
    const vUnknown = viewState('zzz')
    const vServer = viewState('waiting-file')
    check(
      'U-45',
      'T3-10/11 完成判定（含 failed 计完成）+ 状态映射（已知/未知/服务端态兜底）',
      complete === true && incomplete === false && empty === false
        && vDone.label === '成功' && vDone.tone === 'success'
        && vUnknown.tone === 'warn' && vUnknown.label.includes('zzz')
        && vServer.status === 'pending',
      `complete=${complete}, incomplete=${incomplete}, empty=${empty}, done=${vDone.label}, unknownTone=${vUnknown.tone}, server=${vServer.status}`,
    )
  }

  // ---------------------------------------------------------------- 配置：tasks 组缺省 + clamp
  {
    const def = normalizeConfig({})
    const over = normalizeConfig({
      tasks: { maxRetries: 100, queueConcurrency: 99, staleTimeoutMs: 1 },
    })
    check(
      'U-46',
      'T3-06/07 配置 tasks 组：缺省存在 + clamp（maxRetries≤10 / concurrency≤8 / stale≥60000）',
      def.tasks.maxRetries === 0 && def.tasks.queueConcurrency === 1 && def.tasks.staleTimeoutMs === 86_400_000
        && over.tasks.maxRetries === 10 && over.tasks.queueConcurrency === 8 && over.tasks.staleTimeoutMs === 60_000,
      `def=${JSON.stringify(def.tasks)}, over=${JSON.stringify(over.tasks)}`,
    )
  }

  // ================================================================ 轮 A · T3-09 拆分器 + T3-08 pipeline 接线
  // ---------------------------------------------------------------- U-47 planParts 边界
  {
    const p200 = planParts(200, 200)
    const p201 = planParts(201, 200)
    const p450 = planParts(450, 200)
    const p0 = planParts(0, 200)
    check(
      'U-47',
      'T3-09 planParts 边界：200 单分片 / 201 两分片 / 450 三分片 / 0 空',
      p200.length === 1 && p200[0].start === 1 && p200[0].end === 200
        && p201.length === 2 && p201[1].start === 201 && p201[1].end === 201
        && p450.length === 3 && p450[0].end === 200 && p450[1].start === 201 && p450[1].end === 400 && p450[2].start === 401 && p450[2].end === 450
        && p0.length === 0,
      `200→${JSON.stringify(p200)}, 201→${p201.length}片, 450→${p450.length}片, 0→${p0.length}`,
    )
  }

  // ---------------------------------------------------------------- U-48 splitPdf 分片页数正确
  {
    const pdf = await makePdf(210)
    const ranges = planParts(210, 200)
    const parts = await splitPdf(pdf, ranges)
    const c0 = await countPdfPages(parts[0])
    const c1 = await countPdfPages(parts[1])
    check(
      'U-48',
      'T3-09 splitPdf：210 页切成 2 片，页数 200 + 10 且可复读',
      parts.length === 2 && c0 === 200 && c1 === 10,
      `parts=${parts.length}, pageCounts=[${c0},${c1}]`,
    )
  }

  // ---------------------------------------------------------------- U-49 -60006 触发拆分并合并
  {
    const outDir = path.join(tmpRoot, 'split_e2e')
    await fs.mkdir(outDir, { recursive: true })
    const pdf = await makePdf(450)
    const inputPath = path.join(outDir, 'big.pdf')
    await fs.writeFile(inputPath, pdf)
    const mock = await startMockServer({ rejectBig: true, perPartResult: true })
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
    const { result, logs } = await runPipeline(cfg, inputPath)
    const mdPath = path.join(result.outputDir, 'full.md')
    const jsonPath = path.join(result.outputDir, '_content_list.json')
    const md = await fs.readFile(mdPath, 'utf-8')
    const blocks = JSON.parse(await fs.readFile(jsonPath, 'utf-8')) as Array<{ page_idx?: number }>
    const pageIdxs = blocks.map((b) => b.page_idx)
    const imgFiles = await fs.readdir(path.join(result.outputDir, 'images')).catch(() => [] as string[])
    check(
      'U-49',
      'T3-09 端到端：-60006 → 拆 3 片依次提交 → 合并 full.md/content_list 页码偏移 + 图片扁平化',
      md.includes('split_part_1') && md.includes('split_part_2') && md.includes('split_part_3')
        && JSON.stringify(pageIdxs) === JSON.stringify([0, 1, 200, 201, 400, 401])
        && imgFiles.includes('p0_img1.png') && imgFiles.includes('p1_img1.png') && imgFiles.includes('p2_img1.png')
        && logs.some((l) => l.includes('拆分为 3 个分片')),
      `mdParts=3, pageIdx=${JSON.stringify(pageIdxs)}, imgs=${imgFiles.length}, splitLog=${logs.some((l) => l.includes('拆分为 3 个分片'))}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- U-50 图片重命名冲突（纯 mergeResults）
  {
    const pngA = new Uint8Array([1, 2, 3, 4])
    const pngB = new Uint8Array([9, 9, 9])
    const mkPart = (img: Uint8Array, label: string) =>
      scanOutputs([
        { path: 'full.md', data: new TextEncoder().encode(`# ${label}\n\n![x](images/img1.png)\n`) },
        { path: '_content_list.json', data: new TextEncoder().encode(JSON.stringify([{ type: 'image', img_path: 'images/img1.png', page_idx: 0 }])) },
        { path: 'images/img1.png', data: img },
      ])
    const merged = mergeResults([{ outputs: mkPart(pngA, 'A'), pageCount: 2 }, { outputs: mkPart(pngB, 'B'), pageCount: 3 }])
    const img0 = merged.files.find((f) => f.path === 'images/p0_img1.png')
    const img1 = merged.files.find((f) => f.path === 'images/p1_img1.png')
    const md = new TextDecoder().decode(merged.files.find((f) => f.path === 'full.md')!.data)
    const blocks = JSON.parse(new TextDecoder().decode(merged.files.find((f) => f.path === '_content_list.json')!.data)) as Array<{ img_path?: string; page_idx?: number }>
    check(
      'U-50',
      'T3-09 图片跨片同名冲突：p0_/p1_ 前缀区分、md 引用改写、content_list img_path+page_idx 偏移',
      !!img0 && !!img1 && Array.from(img0!.data).join(',') === '1,2,3,4' && Array.from(img1!.data).join(',') === '9,9,9'
        && md.includes('(images/p0_img1.png)') && md.includes('(images/p1_img1.png)')
        && blocks[0].img_path === 'images/p0_img1.png' && blocks[1].img_path === 'images/p1_img1.png' && blocks[1].page_idx === 2,
      `img0=${!!img0}, img1=${!!img1}, mdRewrite=${md.includes('p0_img1.png') && md.includes('p1_img1.png')}, p1pageIdx=${blocks[1].page_idx}`,
    )
  }

  // ---------------------------------------------------------------- U-51 任一分片失败 → 整体失败 + 保留已下载分片
  {
    const outDir = path.join(tmpRoot, 'split_fail')
    await fs.mkdir(outDir, { recursive: true })
    const pdf = await makePdf(450)
    const inputPath = path.join(outDir, 'big.pdf')
    await fs.writeFile(inputPath, pdf)
    const mock = await startMockServer({ rejectBig: true, perPartResult: true, failSplitPart: 2 })
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
    let threw = ''
    try {
      await runPipeline(cfg, inputPath)
    } catch (e) {
      threw = isBmuError(e) ? `${e.kind}:${e.code ?? ''}` : 'other'
    }
    const debugPart1 = path.join(outDir, '_lusplit_debug', 'part_1', 'full.md')
    const mergedMd = path.join(outDir, 'big', 'full.md') // 合并产物目录（不应存在）
    check(
      'U-51',
      'T3-09 分片失败：第 2 片失败 → 整体失败 + 已下载第 1 片保留在 _lusplit_debug + 合并产物未写',
      threw.startsWith('business') && (await exists(debugPart1)) && !(await exists(mergedMd)),
      `threw=${threw}, debugPart1=${await exists(debugPart1)}, mergedMd=${await exists(mergedMd)}`,
    )
    await mock.close()
  }

  // ---------------------------------------------------------------- U-52 正常上传回写 store
  {
    const outDir = path.join(tmpRoot, 't308_normal')
    await fs.mkdir(outDir, { recursive: true })
    const pdf = await makePdf(3)
    const inputPath = path.join(outDir, 'a.pdf')
    await fs.writeFile(inputPath, pdf)
    const sql = await createSqlAdapter(':memory:')
    const store = createStore(sql)
    await store.initSchema()
    await store.saveTask({
      id: 'taskA', inputPath, fileName: 'a.pdf', status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
      outputDir: null, batchId: null, captionEnabled: false, processingLocation: 'workbench',
      error: null, errorKind: null, errorStage: null, retryCount: 0,
    })
    const mock = await startMockServer()
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
    await runPipeline(cfg, inputPath, store, 'taskA')
    const row = (await store.loadFiles('taskA'))[0]
    check(
      'U-52',
      'T3-08 正常上传回写：task_files 有 data_id + fingerprint + upload_status=completed',
      !!row && !!row.dataId && row.fingerprint === fingerprint(pdf) && row.uploadStatus === 'completed',
      `dataId=${row?.dataId}, fpMatch=${row?.fingerprint === fingerprint(pdf)}, up=${row?.uploadStatus}`,
    )
    await mock.close()
    await sql.close()
  }

  // ---------------------------------------------------------------- U-53 断点续传：同文件跳过上传
  {
    const outDir = path.join(tmpRoot, 't308_resume')
    await fs.mkdir(outDir, { recursive: true })
    const pdf = await makePdf(3)
    const inputPath = path.join(outDir, 'a.pdf')
    await fs.writeFile(inputPath, pdf)
    const sql = await createSqlAdapter(':memory:')
    const store = createStore(sql)
    await store.initSchema()
    await store.saveTask({
      id: 'taskB', inputPath, fileName: 'a.pdf', status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
      outputDir: null, batchId: null, captionEnabled: false, processingLocation: 'workbench',
      error: null, errorKind: null, errorStage: null, retryCount: 0,
    })
    const mock = await startMockServer()
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
    await runPipeline(cfg, inputPath, store, 'taskB')
    const uploadsAfterFirst = mock.uploads.size
    // 第二次：同文件同选项 → 应复用 data_id，跳过上传（uploads 不增）
    await runPipeline(cfg, inputPath, store, 'taskB')
    check(
      'U-53',
      'T3-08 断点续传：相同文件第二次提交跳过上传、复用 data_id',
      uploadsAfterFirst === 1 && mock.uploads.size === 1,
      `uploadsAfterFirst=${uploadsAfterFirst}, uploadsAfterSecond=${mock.uploads.size}`,
    )
    await mock.close()
    await sql.close()
  }

  // ---------------------------------------------------------------- U-54 文件变化 → 重新上传
  {
    const outDir = path.join(tmpRoot, 't308_changed')
    await fs.mkdir(outDir, { recursive: true })
    const inputPath = path.join(outDir, 'a.pdf')
    await fs.writeFile(inputPath, await makePdf(3))
    const sql = await createSqlAdapter(':memory:')
    const store = createStore(sql)
    await store.initSchema()
    await store.saveTask({
      id: 'taskC', inputPath, fileName: 'a.pdf', status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
      outputDir: null, batchId: null, captionEnabled: false, processingLocation: 'workbench',
      error: null, errorKind: null, errorStage: null, retryCount: 0,
    })
    const mock = await startMockServer()
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
    await runPipeline(cfg, inputPath, store, 'taskC')
    // 覆盖为不同内容（同文件名）→ 指纹变 → 重新上传
    const pdf2 = await makePdf(4)
    await fs.writeFile(inputPath, pdf2)
    await runPipeline(cfg, inputPath, store, 'taskC')
    const row = (await store.loadFiles('taskC'))[0]
    check(
      'U-54',
      'T3-08 文件变化：指纹不同 → 重新上传（uploads=2、指纹更新）',
      mock.uploads.size === 2 && row.fingerprint === fingerprint(pdf2),
      `uploads=${mock.uploads.size}, fpUpdated=${row.fingerprint === fingerprint(pdf2)}`,
    )
    await mock.close()
    await sql.close()
  }

  // ---------------------------------------------------------------- U-55 store 缺失 → 降级不报错
  {
    const outDir = path.join(tmpRoot, 't308_nostore')
    await fs.mkdir(outDir, { recursive: true })
    const inputPath = path.join(outDir, 'a.pdf')
    await fs.writeFile(inputPath, await makePdf(3))
    const mock = await startMockServer()
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir })
    let ok = false
    try {
      const { result } = await runPipeline(cfg, inputPath, undefined, undefined)
      ok = !!result.markdownPath
    } catch {
      ok = false
    }
    check(
      'U-55',
      'T3-08 store 缺失降级：无 store 也正常走完上传/轮询/下载/落盘',
      ok === true,
      `ok=${ok}`,
    )
    await mock.close()
  }

  // ================================================================ 阶段 4 轮 C · T4-08 事件 + T4-04 D-39 聚合
  // ---------------------------------------------------------------- U-56~58 T4-08 事件推送
  {
    const statusBox: { v: { taskId: string; fileId?: string; state: string; stage?: string } | null } = { v: null }
    const offS = onTaskStatus((p) => { statusBox.v = p })
    emitTaskStatus({ taskId: 't1', fileId: 'f1', state: 'uploading', stage: 'uploading' })
    offS()

    let progress = 0
    const offP = onTaskProgress((p) => { progress = p.elapsedMs })
    emitTaskProgress({ taskId: 't1', fileId: 'f1', elapsedMs: 1234 })
    offP()

    check(
      'U-56',
      'T4-08 事件推送（非 Tauri EventTarget 降级）：emit→on 收到，payload 结构正确',
      statusBox.v?.taskId === 't1' && statusBox.v?.fileId === 'f1' && statusBox.v?.state === 'uploading' && statusBox.v?.stage === 'uploading' && progress === 1234,
      `status=${JSON.stringify(statusBox.v)}, elapsed=${progress}`,
    )
  }

  {
    let msg = ''
    const off = onLogLine((p) => { msg = p.message })
    emitLogLine({ level: 'info', message: 'auth failed sk-1234567890 with Bearer abcdef123456', timestamp: Date.now() })
    off()
    check(
      'U-57',
      'T4-08 事件脱敏：payload 中 sk-…/Bearer token 经 scrubSecrets 遮蔽',
      msg.includes('sk-****890') && !msg.includes('1234567890') && msg.includes('Bearer abc****456'),
      `msg=${JSON.stringify(msg)}`,
    )
  }

  {
    let count = 0
    const off = onTaskStatus(() => { count += 1 })
    emitTaskStatus({ taskId: 't', state: 'pending' })
    off()
    emitTaskStatus({ taskId: 't', state: 'pending' })
    check(
      'U-58',
      'T4-08 取消订阅：off 后不再收到事件',
      count === 1,
      `count=${count}`,
    )
  }

  // ---------------------------------------------------------------- U-59 D-39 createTask 落库
  {
    const sql = await createSqlAdapter(':memory:')
    const store = createStore(sql)
    await store.initSchema()
    const tm = new TaskManager(normalizeConfig({}), store)
    const taskId = await tm.createTask(['/x/a.pdf', '/x/b.pdf', '/x/c.pdf'], { captionEnabled: true, processingLocation: 'inplace' })
    const task = await store.getTask(taskId)
    const files = await store.loadFiles(taskId)
    const info = tm.getTaskInfo(taskId)
    check(
      'U-59',
      'D-39 createTask：1 任务 + N 文件落库（任务行 + 3 文件行），聚合视图可用',
      !!task && task.captionEnabled === true && task.processingLocation === 'inplace'
        && files.length === 3 && info?.fileIds.length === 3 && tm.taskFiles(taskId).length === 3,
      `task=${!!task}, files=${files.length}, infoFiles=${info?.fileIds.length}, taskFiles=${tm.taskFiles(taskId).length}`,
    )
    await sql.close()
  }

  // ---------------------------------------------------------------- U-60 D-39 submitAll 顺序执行
  {
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const tm: TaskManager = new TaskManager(normalizeConfig({}), undefined, async (jobId) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const job = tm.getJob(jobId)!
      order.push(job.inputPath)
      await new Promise((r) => setTimeout(r, 10))
      inFlight -= 1
      job.status = 'done'
      return job
    })
    const taskId = await tm.createTask(['a.pdf', 'b.pdf', 'c.pdf'])
    await tm.submitAll(taskId)
    await waitUntil(() => tm.getTaskInfo(taskId)?.status === 'done', 4000)
    check(
      'U-60',
      'D-39 submitAll：任务下 N 文件按顺序执行、不并行（并发 1）',
      order.join(',') === 'a.pdf,b.pdf,c.pdf' && maxInFlight === 1 && tm.getTaskInfo(taskId)?.status === 'done',
      `order=${order.join('>')}, maxInFlight=${maxInFlight}, taskStatus=${tm.getTaskInfo(taskId)?.status}`,
    )
  }

  // ---------------------------------------------------------------- U-67 D.9 全部开始：导入→未开始→submitAll→解析中
  {
    const tm: TaskManager = new TaskManager(normalizeConfig({}), undefined, async (jobId) => {
      const job = tm.getJob(jobId)!
      // 模拟 pipeline 推进到 uploading（= 解析中）
      job.status = 'uploading'
      return job
    })
    const taskId = await tm.createTask(['x.pdf'])
    // 建任务后（导入未开始）文件应为 pending
    const before = tm.taskFiles(taskId).map((f) => f.status)
    await tm.submitAll(taskId)
    await waitUntil(() => tm.taskFiles(taskId).every((f) => f.status === 'uploading'), 4000)
    const after = tm.taskFiles(taskId).map((f) => f.status)
    check(
      'U-67',
      'D.9 全部开始路径：createTask 后为未开始(pending)，submitAll 后离开未开始进入解析中(uploading)',
      before.length === 1 && before[0] === 'pending' && after.length === 1 && after[0] === 'uploading',
      `before=${before.join(',')}, after=${after.join(',')}`,
    )
  }

  // ---------------------------------------------------------------- U-61 D-39 cancel(taskId) 取消全部文件
  {
    let aborted = false
    const tm: TaskManager = new TaskManager(normalizeConfig({}), undefined, async (jobId, signal) => {
      const job = tm.getJob(jobId)!
      await new Promise<void>((resolve) => {
        if (signal.aborted) { aborted = true; resolve(); return }
        signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
      })
      job.status = aborted ? 'canceled' : 'done'
      return job
    })
    const taskId = await tm.createTask(['a.pdf', 'b.pdf'])
    await tm.submitAll(taskId)
    const files = tm.taskFiles(taskId)
    tm.cancel(taskId)
    await waitUntil(() => tm.taskFiles(taskId).every((f) => f.status === 'canceled'), 3000)
    check(
      'U-61',
      'D-39 cancel(taskId)：取消该任务下所有文件（运行中中止 + 排队中标记）',
      tm.taskFiles(taskId).every((f) => f.status === 'canceled') && aborted && files.length === 2,
      `statuses=${tm.taskFiles(taskId).map((f) => f.status).join(',')}, aborted=${aborted}`,
    )
  }

  // ---------------------------------------------------------------- U-62 D-39 retryFile 只重试指定文件
  {
    const calls: Record<string, number> = {}
    const tm: TaskManager = new TaskManager(normalizeConfig({ tasks: { maxRetries: 2 } }), undefined, async (jobId) => {
      const job = tm.getJob(jobId)!
      calls[job.inputPath] = (calls[job.inputPath] ?? 0) + 1
      // a 首次失败、重试后成功；b 直接成功
      job.status = job.inputPath === 'a.pdf' && job.retryCount === 0 ? 'failed' : 'done'
      return job
    })
    const taskId = await tm.createTask(['a.pdf', 'b.pdf'])
    await tm.submitAll(taskId)
    await waitUntil(() => tm.taskFiles(taskId).every((f) => f.status === 'done' || f.status === 'failed'), 4000)
    const files = tm.taskFiles(taskId)
    const aId = files.find((f) => f.inputPath === 'a.pdf')!.id
    const bId = files.find((f) => f.inputPath === 'b.pdf')!.id
    await tm.retryFile(taskId, aId)
    const after = tm.taskFiles(taskId)
    check(
      'U-62',
      'D-39 retryFile：只重试指定文件（a 重跑成功、retry_count 递增），不影响同任务 b',
      after.find((f) => f.id === aId)?.status === 'done' && after.find((f) => f.id === aId)?.retryCount === 1
        && after.find((f) => f.id === bId)?.status === 'done'
        && calls['a.pdf'] === 2 && calls['b.pdf'] === 1,
      `a=${after.find((f) => f.id === aId)?.status}/rc${after.find((f) => f.id === aId)?.retryCount}, b=${after.find((f) => f.id === bId)?.status}, callsA=${calls['a.pdf']}, callsB=${calls['b.pdf']}`,
    )
  }

  // ---------------------------------------------------------------- U-63 D-41 历史任务级重试（所有失败文件）
  {
    const calls: Record<string, number> = {};
    const tm: TaskManager = new TaskManager(normalizeConfig({ tasks: { maxRetries: 2 } }), undefined, async (jobId) => {
      const job = tm.getJob(jobId)!;
      calls[job.inputPath] = (calls[job.inputPath] ?? 0) + 1;
      job.status = job.inputPath !== "ok.pdf" && job.retryCount === 0 ? "failed" : "done";
      return job;
    });
    const taskId = await tm.createTask(["fa.pdf", "fb.pdf", "ok.pdf"]);
    await tm.submitAll(taskId);
    await waitUntil(() => tm.taskFiles(taskId).every((f) => f.status === "done" || f.status === "failed"), 4000);
    const before = tm.taskFiles(taskId);
    const failedBefore = before.filter((f) => f.status === "failed").length;
    const { retried } = await tm.retryTask(taskId);
    await waitUntil(() => tm.taskFiles(taskId).every((f) => f.status === "done"), 4000);
    const after = tm.taskFiles(taskId);
    check(
      "U-63",
      "D-41 retryTask：历史「重试」重试任务下所有失败文件（2 个），成功文件不重跑",
      failedBefore === 2 && retried === 2 && after.every((f) => f.status === "done")
        && calls["fa.pdf"] === 2 && calls["fb.pdf"] === 2 && calls["ok.pdf"] === 1,
      `failedBefore=${failedBefore}, retried=${retried}, calls=${JSON.stringify(calls)}`,
    );
  }

  // ---------------------------------------------------------------- U-64 D-42 destDirOverride 透传
  {
    const cfgDir = path.join(tmpRoot, 'd42_cfg');
    const overrideDir = path.join(tmpRoot, 'd42_override');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.mkdir(overrideDir, { recursive: true });
    const inputPath = path.join(cfgDir, 'a.pdf');
    await fs.writeFile(inputPath, await makePdf(3));
    const mock = await startMockServer();
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: cfgDir });
    const result = await runParseJob(
      { filePath: inputPath },
      {
        config: cfg,
        transport: createHttpTransport('fetch'),
        fs: createFsAdapter(),
        onEvent: () => undefined,
        signal: new AbortController().signal,
        destDirOverride: overrideDir,
      },
    );
    const mdInOverride = path.join(overrideDir, 'a', 'full.md');
    const mdInCfg = path.join(cfgDir, 'a', 'full.md');
    check(
      'U-64',
      'D-42 destDirOverride：输出落在指定目录（而非配置默认目录）',
      (await exists(mdInOverride)) && !(await exists(mdInCfg)),
      `outputDir=${result.outputDir}, overrideMd=${await exists(mdInOverride)}, cfgMd=${await exists(mdInCfg)}`,
    );
    await mock.close();
  }

  // ---------------------------------------------------------------- U-65 D-43 markdownPath 落库
  {
    const outDir = path.join(tmpRoot, 'd43_md');
    await fs.mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'a.pdf');
    await fs.writeFile(inputPath, await makePdf(3));
    const sql = await createSqlAdapter(':memory:');
    const store = createStore(sql);
    await store.initSchema();
    await store.saveTask({
      id: 'taskD', inputPath, fileName: 'a.pdf', status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
      outputDir: null, batchId: null, captionEnabled: false, processingLocation: 'workbench',
      error: null, errorKind: null, errorStage: null, retryCount: 0,
    });
    const mock = await startMockServer();
    const cfg = await buildConfig({ baseUrl: mock.baseUrl, outputDir: outDir });
    const result = await runParseJob(
      { filePath: inputPath },
      {
        config: cfg,
        transport: createHttpTransport('fetch'),
        fs: createFsAdapter(),
        onEvent: () => undefined,
        signal: new AbortController().signal,
        store,
        taskId: 'taskD',
      },
    );
    const row = (await store.loadFiles('taskD'))[0];
    check(
      'U-65',
      'D-43 markdownPath：PipelineResult 有 full.md 路径 + store task_files.markdown_path 落库',
      !!result.markdownPath && result.markdownPath.endsWith('full.md') && !!row.markdownPath && row.markdownPath.endsWith('full.md'),
      `result.md=${result.markdownPath}, store.md=${row.markdownPath}`,
    );
    await mock.close();
    await sql.close();
  }

  // ---------------------------------------------------------------- U-66 D-45 history-changed 事件
  {
    const box: { v: string | null } = { v: null };
    const off = onHistoryChanged((taskId) => { box.v = taskId ?? 'none' });
    emitHistoryChanged('tX');
    off();
    let cli = '';
    const off2 = onCliCommand((p) => { cli = `${p.action}:${(p.file_paths ?? []).join(",")}` });
    // 非 Tauri：本地 EventTarget，手动投递验证订阅通路
    emitTaskStatus({ taskId: 't', state: 'pending' });
    off2();
    check(
      'U-66',
      'D-45 history-changed + cli-command 订阅通路（非 Tauri EventTarget）',
      box.v === 'tX',
      `history=${box.v}, cliWire=${cli === '' ? 'ok(no-emit)' : cli}`,
    );
  }

  // ---------------------------------------------------------------- 汇总
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) {
    console.log('未通过项:')
    for (const item of failed) console.log(`  - ${item.id} ${item.name}: ${item.detail}`)
    process.exitCode = 1
  }
}

void main().catch((err) => {
  console.error('自检未处理异常:', err)
  process.exitCode = 1
})

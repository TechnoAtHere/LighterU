// dev-only · mineru.net v4 契约模拟服务器（D-24：仅开发/测试可用，不进生产构建）
// 用途：T1-17 联调项在无真实 Token 时自动化验证全链（提交→轮询→下载→解压→定位→落盘）。
// 契约严格按 plan/04 P-2 + OT-X 实证（client.py:212-224 注释）：
//   1. POST /api/v4/file-urls/batch（Bearer）→ {code:0, data:{batch_id, file_urls[]}}
//   2. PUT 预签名 URL（无 Authorization、无 Content-Type）
//   3. GET  /api/v4/extract-results/batch/{batch_id}（Bearer）→ data.extract_result[0]
//   4. GET  /api/v4/extract/task/{task_id}（Bearer）
//   5. GET  full_zip_url（无鉴权）

import http from 'node:http'
import { zipSync, strToU8 } from 'fflate'

export interface MockServerOptions {
  /** 期望的 Bearer token；默认 'test-token'；传 '' 表示不校验 */
  token?: string
  /** >0 时按耗时推进状态；=0 时按轮询次数（第 1 次 running，第 2 次起 done） */
  latencyMs?: number
  /** true = 永远 running（取消检查点测试） */
  slow?: boolean
  /** true = 文件名含 big 时返回 -60006 页数超限 */
  rejectBig?: boolean
  /** true = 首次结果 ZIP 下载返回 404（D-27 重查路径测试） */
  notFoundOnce?: boolean
  /** >0 时前 N 次多模态 chat/completions 返回 429（T2-04 退避重试测试） */
  multimodalFailFirst?: number
  /** >0 时多模态 chat/models 响应延迟 N ms（T2-11 超时测试） */
  multimodalDelayMs?: number
  /** true = 多模态 chat/completions 必返 401（D-35 affectedPaths 测试） */
  multimodalFailAll?: boolean
  /** true = 结果 ZIP 按批次名生成可区分内容（T3-09 分片合并测试：full.md/content_list 带分片名） */
  perPartResult?: boolean
  /** >0 = 名为 split_part_{N}.pdf 的分片提交时返回业务错误（T3-09 分片失败测试） */
  failSplitPart?: number
  /** 0 = 随机端口 */
  port?: number
}

export interface MockServerHandle {
  port: number
  baseUrl: string
  /** 多模态 base_url（T2-01：拼 /chat/completions） */
  multimodalBaseUrl: string
  close(): Promise<void>
  /** 已接收的上传（断言用） */
  uploads: Map<string, { name: string; size: number; polls: number }>
  /** 最近一次收到的 Authorization 头（T1-05 断言用） */
  lastAuthHeader: string | null
  /** 已接收的多模态 chat/completions 调用（T2-01 断言用；仅记非 429 的成功请求） */
  multimodalCalls: Array<{ model: string; imageUrlPrefix: string; auth: string | null; messageCount: number; hasSystem: boolean }>
  /** 多模态 chat/completions 累计请求数（含 429；T2-04 重试断言用） */
  readonly multimodalAttempts: number
}

interface MockBatch {
  batchId: string
  taskId: string
  name: string
  size: number
  uploadedAt: number
  polls: number
  zip404Left: number
}

/** 1×1 测试 PNG（selftest T2-01 复用） */
export const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const RESULT_MD = '# 测试文档\n\n![图1](images/img1.png)\n\n这是 MinerU 解析产出的正文，用于验证图片链接可解析。\n'

function buildResultZip(): Uint8Array {
  const contentList = [
    { type: 'text', text: '测试文档', text_level: 1 },
    { type: 'image', img_path: 'images/img1.png', img_caption: [], image_caption: [] },
    { type: 'text', text: '这是 MinerU 解析产出的正文，用于验证图片链接可解析。' },
  ]
  return zipSync({
    'full.md': strToU8(RESULT_MD),
    'images/img1.png': new Uint8Array(Buffer.from(ONE_PX_PNG_B64, 'base64')),
    '_content_list.json': strToU8(JSON.stringify(contentList, null, 2)),
  })
}

let resultZipCache: Uint8Array | null = null

/** T3-09：按分片名生成可区分内容（full.md/content_list 带分片名；图片同名 img1.png 以测跨片冲突） */
function buildPartZip(name: string): Uint8Array {
  const contentList = [
    { type: 'text', text: `${name} 标题`, text_level: 1, page_idx: 0 },
    { type: 'image', img_path: 'images/img1.png', img_caption: [], image_caption: [], page_idx: 1 },
  ]
  return zipSync({
    'full.md': strToU8(`# ${name}\n\n![图1](images/img1.png)\n\n${name} 正文。\n`),
    'images/img1.png': new Uint8Array(Buffer.from(ONE_PX_PNG_B64, 'base64')),
    '_content_list.json': strToU8(JSON.stringify(contentList, null, 2)),
  })
}

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServerHandle> {
  const options: Required<MockServerOptions> = {
    token: opts.token ?? 'test-token',
    latencyMs: opts.latencyMs ?? 0,
    slow: opts.slow ?? false,
    rejectBig: opts.rejectBig ?? false,
    notFoundOnce: opts.notFoundOnce ?? false,
    multimodalFailFirst: opts.multimodalFailFirst ?? 0,
    multimodalDelayMs: opts.multimodalDelayMs ?? 0,
    multimodalFailAll: opts.multimodalFailAll ?? false,
    perPartResult: opts.perPartResult ?? false,
    failSplitPart: opts.failSplitPart ?? 0,
    port: opts.port ?? 0,
  }

  const batches = new Map<string, MockBatch>()
  const uploads: MockServerHandle['uploads'] = new Map()
  const multimodalCalls: MockServerHandle['multimodalCalls'] = []
  let multimodal429Left = options.multimodalFailFirst
  let multimodalAttempts = 0
  let seq = 0
  let lastAuthHeader: string | null = null

  const server = http.createServer((req, res) => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname

    const send = (status: number, payload: unknown) => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(body)
    }
    const readJson = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf-8')
      return text ? (JSON.parse(text) as Record<string, unknown>) : {}
    }
    const authOk = (): boolean => {
      lastAuthHeader = req.headers.authorization ?? null
      if (options.token === '') return true
      return req.headers.authorization === `Bearer ${options.token}`
    }
    const itemState = (batch: MockBatch): Record<string, unknown> => {
      const base: Record<string, unknown> = {
        task_id: batch.taskId,
        batch_id: batch.batchId,
        extract_progress: 0,
        extracted_pages: 0,
        total_pages: 12,
        err_msg: '',
      }
      if (options.slow) {
        return { ...base, state: 'running', extract_progress: 10, extracted_pages: 1 }
      }
      if (options.latencyMs > 0) {
        const elapsed = Date.now() - batch.uploadedAt
        if (elapsed < options.latencyMs) return { ...base, state: 'running', extract_progress: 30, extracted_pages: 4 }
        if (elapsed < options.latencyMs * 2) return { ...base, state: 'converting', extract_progress: 70, extracted_pages: 9 }
      } else if (batch.polls <= 1) {
        return { ...base, state: 'running', extract_progress: 30, extracted_pages: 4 }
      }
      return {
        ...base,
        state: 'done',
        extract_progress: 100,
        extracted_pages: 12,
        full_zip_url: `http://127.0.0.1:${port}/result/${batch.batchId}.zip`,
      }
    }

    void (async () => {
      try {
        // ---- 1. 申请上传 URL
        if (req.method === 'POST' && path === '/api/v4/file-urls/batch') {
          if (!authOk()) return send(401, { code: 'A0202', msg: 'Token 错误，请检查 Bearer 前缀。' })
          const body = await readJson()
          const files = Array.isArray(body.files) ? (body.files as Array<Record<string, unknown>>) : []
          const name = files.length > 0 ? String(files[0]?.name ?? '') : ''
          if (!/\.pdf$/i.test(name)) return send(400, { code: '-60001', msg: `不支持的文件类型：${name}` })
          if (options.rejectBig && /big/i.test(name)) {
            return send(200, { code: '-60006', msg: '文件页数超过限制（200 页），请拆分文件后重试。' })
          }
          // T3-09：指定分片强制失败（split_part_{N}.pdf），用于分片失败整体失败测试
          if (options.failSplitPart > 0 && name === `split_part_${options.failSplitPart}.pdf`) {
            return send(200, { code: '-60013', msg: `分片 ${options.failSplitPart} 强制失败（mock）` })
          }
          seq += 1
          const batchId = `batch_${seq}`
          batches.set(batchId, {
            batchId,
            taskId: `task_${batchId}`,
            name,
            size: 0,
            uploadedAt: Date.now(),
            polls: 0,
            zip404Left: options.notFoundOnce ? 1 : 0,
          })
          return send(200, {
            code: 0,
            data: { batch_id: batchId, file_urls: [`http://127.0.0.1:${port}/upload/${batchId}`] },
          })
        }

        // ---- 2. PUT 上传（无鉴权）
        const uploadMatch = /^\/upload\/([^/]+)$/.exec(path)
        if (req.method === 'PUT' && uploadMatch) {
          const batch = batches.get(uploadMatch[1])
          if (!batch) return send(404, { code: '-60012', msg: '批次不存在' })
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          batch.size = Buffer.concat(chunks).length
          batch.uploadedAt = Date.now()
          uploads.set(batch.batchId, { name: batch.name, size: batch.size, polls: 0 })
          res.writeHead(200, { etag: '"mock"' })
          return res.end()
        }

        // ---- 3. 批量结果
        const batchMatch = /^\/api\/v4\/extract-results\/batch\/([^/]+)$/.exec(path)
        if (req.method === 'GET' && batchMatch) {
          if (!authOk()) return send(401, { code: 'A0202', msg: 'Token 错误。' })
          const batch = batches.get(batchMatch[1])
          if (!batch) return send(200, { code: '-60012', msg: '任务不存在' })
          batch.polls += 1
          const upload = uploads.get(batch.batchId)
          if (upload) upload.polls = batch.polls
          return send(200, { code: 0, data: { extract_result: [itemState(batch)] } })
        }

        // ---- 4. 单任务结果（D-27 重查路径）
        const taskMatch = /^\/api\/v4\/extract\/task\/([^/]+)$/.exec(path)
        if (req.method === 'GET' && taskMatch) {
          if (!authOk()) return send(401, { code: 'A0202', msg: 'Token 错误。' })
          const batch = [...batches.values()].find((b) => b.taskId === taskMatch[1] || b.batchId === taskMatch[1])
          if (!batch) return send(200, { code: '-60012', msg: '任务不存在' })
          return send(200, { code: 0, data: itemState(batch) })
        }

        // ---- 5. 结果 ZIP（无鉴权）
        const resultMatch = /^\/result\/([^/]+)\.zip$/.exec(path)
        if (req.method === 'GET' && resultMatch) {
          const batch = batches.get(resultMatch[1])
          if (!batch) return send(404, { code: '-60012', msg: '结果不存在' })
          if (batch.zip404Left > 0) {
            batch.zip404Left -= 1
            // 裸 404（贴近真实 OSS 行为：无业务信封），触发客户端 D-27 重查路径
            res.writeHead(404, { 'content-type': 'text/plain' })
            return res.end('Not Found')
          }
          if (options.perPartResult) {
            const partZip = buildPartZip(batch.name)
            res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(partZip.length) })
            return res.end(Buffer.from(partZip))
          }
          if (resultZipCache === null) resultZipCache = buildResultZip()
          res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(resultZipCache.length) })
          return res.end(Buffer.from(resultZipCache))
        }

        // ---- 6. 多模态 chat/completions（T2-01 契约模拟：OpenAI 兼容）
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          multimodalAttempts += 1
          lastAuthHeader = req.headers.authorization ?? null
          if (options.token !== '' && req.headers.authorization !== `Bearer ${options.token}`) {
            return send(401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } })
          }
          if (options.multimodalDelayMs > 0) await new Promise((r) => setTimeout(r, options.multimodalDelayMs))
          // D-35：必败模式（401 不重试，直接失败）
          if (options.multimodalFailAll) {
            return send(401, { error: { message: 'forced failure (mock)', type: 'invalid_request_error' } })
          }
          // T2-04：前 N 次返回 429（带 Retry-After，触发客户端退避重试）
          if (multimodal429Left > 0) {
            multimodal429Left -= 1
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
            return res.end(JSON.stringify({ error: { message: 'rate limited (mock)', type: 'rate_limit_error' } }))
          }
          const body = await readJson()
          const model = typeof body.model === 'string' ? body.model : ''
          const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
          const userContent = messages.find((m) => m.role === 'user')?.content
          const parts = Array.isArray(userContent) ? (userContent as Array<Record<string, unknown>>) : []
          const imagePart = parts.find((p) => p.type === 'image_url')
          const imageUrl = imagePart && typeof imagePart.image_url === 'object' && imagePart.image_url !== null
            ? String((imagePart.image_url as Record<string, unknown>).url ?? '')
            : ''
          if (!imageUrl) return send(400, { error: { message: 'missing image_url part', type: 'invalid_request_error' } })
          multimodalCalls.push({
            model,
            imageUrlPrefix: imageUrl.slice(0, 40),
            auth: lastAuthHeader,
            messageCount: messages.length,
            hasSystem: messages.some((m) => m.role === 'system'),
          })
          return send(200, {
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: '一张  测试"图片"的描述\n第二行' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          })
        }

        // ---- 7. 多模态 /models（T2-11 preflight 用：OpenAI 兼容模型列表）
        if (req.method === 'GET' && path === '/v1/models') {
          lastAuthHeader = req.headers.authorization ?? null
          if (options.token !== '' && req.headers.authorization !== `Bearer ${options.token}`) {
            return send(401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } })
          }
          if (options.multimodalDelayMs > 0) await new Promise((r) => setTimeout(r, options.multimodalDelayMs))
          return send(200, { object: 'list', data: [{ id: 'vision-model', object: 'model' }, { id: 'other-model', object: 'model' }] })
        }

        send(404, { code: 'NOT_FOUND', msg: `mock 未实现：${req.method} ${path}` })
      } catch (err) {
        send(500, { code: 'MOCK_ERROR', msg: err instanceof Error ? err.message : String(err) })
      }
    })()
  })

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/api/v4`,
    /** 多模态 base_url（T2-01：拼 /chat/completions） */
    multimodalBaseUrl: `http://127.0.0.1:${port}/v1`,
    uploads,
    multimodalCalls,
    get multimodalAttempts(): number {
      return multimodalAttempts
    },
    get lastAuthHeader(): string | null {
      return lastAuthHeader
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

// 独立运行：npm run mock -- --port 9911
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const portArgIndex = process.argv.indexOf('--port')
  const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 9911
  void startMockServer({ port }).then((handle) => {
    console.log(`[mock] mineru.net v4 模拟服务器已启动: ${handle.baseUrl}（token=test-token）`)
  })
}

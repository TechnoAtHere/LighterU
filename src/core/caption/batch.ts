// M04 · core/caption/batch — 并发批处理池（T2-03）
// 语义参照 TS-X006/010~012（天枢 caption_batch）：固定并发池、单张失败只记录不阻断其余、
// 成功项进 Map。TS 侧以 async 池实现（纯网络 IO，无需线程）。
// MIT License — 结构改编自 mineru-tianshu（Apache 2.0，保留版权声明）；按 D-07 以 TS 重写。

/** 默认并发（TS-X006：天枢 DEFAULT_CONCURRENCY=4；配置项 multimodal.concurrency 可覆盖） */
export const DEFAULT_CONCURRENCY = 4

export interface BatchFailure {
  path: string
  error: string
}

export interface BatchResult<T> {
  /** 成功项：path → 值（插入顺序 = 完成顺序） */
  values: Map<string, T>
  /** 失败项（TS-X010~012：单张失败不阻断整体；R6 部分失败语义由此承载） */
  failures: BatchFailure[]
}

export interface BatchOptions {
  /** 并发上限（>=1；默认 DEFAULT_CONCURRENCY） */
  concurrency?: number
  /** 取消信号：已中止则不再领取新任务（在途任务自行失败） */
  signal?: AbortSignal
  /** 每完成一项（成功或失败）回调 */
  onProgress?: (done: number, total: number) => void
  /** 失败项日志（调用方透传到 UI/诊断） */
  onFailure?: (path: string, error: string) => void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 固定并发池执行（T2-03 验收：N 项按配置并发返回 Map；单张失败不阻断其余）。
 * - 并发数 = min(concurrency, items.length)；worker 自主领取下一项，无预分配
 * - 任何一项抛错 → 记 failures + onFailure，继续其余项
 * - signal 中止 → 未领取项不再开始；在途项的错误按失败记录（取消类错误信息含「已取消」）
 */
export async function runPool<T>(
  items: string[],
  worker: (path: string) => Promise<T>,
  opts: BatchOptions = {},
): Promise<BatchResult<T>> {
  const result: BatchResult<T> = { values: new Map(), failures: [] }
  if (items.length === 0) return result

  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY))
  const total = items.length
  let nextIndex = 0
  let done = 0

  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return
      const index = nextIndex
      nextIndex += 1
      if (index >= total) return
      const path = items[index]
      try {
        const value = await worker(path)
        result.values.set(path, value)
      } catch (err) {
        const message = messageOf(err)
        result.failures.push({ path, error: message })
        opts.onFailure?.(path, message)
      } finally {
        done += 1
        opts.onProgress?.(done, total)
      }
    }
  }

  const workers: Array<Promise<void>> = []
  for (let i = 0; i < Math.min(concurrency, total); i += 1) workers.push(runWorker())
  await Promise.all(workers)
  return result
}

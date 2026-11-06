// dev-only · 诊断日志（D-24）：增量写入 <AppLogDir>/lu-diag.log
// 用途：in-app 探针无 GUI 可见时的取证通道；同时写启动标记与前端异常。
// 仅依赖自定义 Rust 命令 lu_write_file（不依赖任何插件），用于区分「前端是否加载」。
//
// 2026-10-22 修复：
// 1) 路径必须用 @tauri-apps/api/path 的 join 拼接——appConfigDir() 在 Windows 上
//    不带结尾分隔符，旧代码 `${dir}${FILE_NAME}` 会写成上一级的
//    %APPDATA%\com.lighteru.applu-diag.log（用户在白名单目录里看不到文件）。
// 2) 写入失败不再静默吞掉：console.warn + 可选 UI 回调（onDiagWriteFailure）。
// 3) 单文件 5MB 滚动上限，防止长时间挂机无限增长。

const FILE_NAME = 'lu-diag.log'

/** 单文件上限 5MB：超出后从头部滚动裁剪（flush 重写全量，故文件大小受此约束） */
export const DIAG_MAX_BYTES = 5 * 1024 * 1024

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * 诊断缓冲：追加带时间戳的行并按 5MB 滚动裁剪。
 * 纯逻辑（无 IO），Node 侧可直接单测。
 */
export class DiagBuffer {
  private lines: string[] = []
  private bytes = 0

  /** 追加一行，返回带 ISO 时间戳的完整行 */
  append(text: string): string {
    const stamped = `${new Date().toISOString()}  ${text}`
    this.lines.push(stamped)
    this.bytes += byteLength(stamped) + 1
    while (this.bytes > DIAG_MAX_BYTES && this.lines.length > 1) {
      const dropped = this.lines.shift()
      if (dropped !== undefined) this.bytes -= byteLength(dropped) + 1
    }
    return stamped
  }

  /** 全量快照（flush 时整体重写文件） */
  snapshot(): string {
    return this.lines.join('\n') + '\n'
  }

  get size(): number {
    return this.bytes
  }

  get count(): number {
    return this.lines.length
  }
}

/** 诊断日志完整路径：Tauri path 插件的 join（Rust 侧 PathBuf 语义，平台正确分隔符） */
export async function diagLogPath(): Promise<string> {
  // 安全：诊断日志与普通日志一起放在 $APPLOG，避免为写日志开放配置目录写权限
  const { appLogDir, join } = await import('@tauri-apps/api/path')
  return await join(await appLogDir(), FILE_NAME)
}

const buffer = new DiagBuffer()
let flushing = false

/** 写入失败回调（供 UI 日志面板提示；诊断通道自身失败不得静默） */
let failureListener: ((err: unknown) => void) | null = null

export function onDiagWriteFailure(listener: ((err: unknown) => void) | null): void {
  failureListener = listener
}

async function flush(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('lu_write_file', {
      path: await diagLogPath(),
      data: new TextEncoder().encode(buffer.snapshot()),
    })
  } catch (err) {
    // 诊断通道自身失败：不递归写 diag，但必须留痕（console + UI 回调），不静默吞掉。
    console.warn('[lu-diag] 诊断日志写入失败：', err)
    try {
      failureListener?.(err)
    } catch {
      // 监听器自身异常不扩散
    }
  } finally {
    flushing = false
  }
}

/** 追加一行诊断并立即落盘 */
export async function diag(line: string): Promise<void> {
  buffer.append(line)
  await flush()
}

/** 安装全局错误捕获（未处理 rejection / error） */
export function installDiagHooks(): void {
  window.addEventListener('unhandledrejection', (event) => {
    void diag(`unhandledrejection: ${String((event as PromiseRejectionEvent).reason)}`)
  })
  window.addEventListener('error', (event) => {
    void diag(`window.error: ${event.message} @ ${event.filename}:${event.lineno}`)
  })
}

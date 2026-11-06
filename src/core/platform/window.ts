// platform · 多窗口助手（T4-11/T4-06）：打开小窗 / 进度窗，跨窗口传文件用事件握手。
// 窗口在 tauri.conf.json 预定义（visible:false 启动隐藏）；此处按 label 取出并 show/setFocus。
// 非 Tauri（浏览器 dev / selftest）降级为 no-op，不报错。
// 跨窗口「同一事件源」：各窗口经 lu: 事件（T4-08）同步显示；直接解析的文件经 lu:direct-parse 握手传递。

import { isTauri } from './env'
import { log } from './logger'

const DIALOG_FILE = 'lu:dialog-file'

/** D.7：窗口操作失败不再静默吞掉——至少 console.error 一次，便于定位（尤其是 capabilities 权限被拒）。 */
function reportWindowError(scope: string, err: unknown): void {
  console.error(`[lu] 窗口操作失败(${scope}):`, err);
  const msg = err instanceof Error ? err.message : String(err);
  if (/permission|denied|not allowed|acl/i.test(msg)) {
    console.error("[lu] 权限被拒，检查 capabilities 是否为该窗口授予 core:window:allow-show / allow-set-focus");
  }
}

async function showWindow(label: string): Promise<boolean> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  log('debug', 'window', 'showWindow.enter', { label })
  const win = await WebviewWindow.getByLabel(label)
  if (!win) {
    log('warn', 'window', 'showWindow.notFound', { label })
    return false
  }
  await win.show()
  await win.setFocus()
  log('debug', 'window', 'showWindow.ok', { label })
  return true
}

/**
 * T4-11：打开「解析…」小窗。
 * @deprecated D.8 小窗退役——工程文件保留、不打包、无任何入口调用；保留供将来可能的模态入口复用。
 */
export async function openParseDialog(): Promise<void> {
  if (!isTauri()) return
  try {
    await showWindow('parse-dialog')
  } catch (err) {
    reportWindowError('openParseDialog', err)
  }
}

/**
 * T4-03：打开小窗并把待解析文件交给它（原 --parse-to / 右键「解析到…」）。
 * @deprecated D.8 小窗 + 「解析到…」退役——无入口调用；保留供将来。
 * 握手：先注册 ready 监听 → show → 小窗 mount 后发 ready → 收到即发 dialog-file。
 */
export async function openParseDialogWithFile(filePath: string): Promise<void> {
  if (!isTauri()) return
  try {
    const { emit, listen } = await import('@tauri-apps/api/event')
    const unsub = await listen('lu:dialog-ready', async () => {
      unsub()
      await emit(DIALOG_FILE, { filePath })
    })
    const ok = await showWindow('parse-dialog')
    if (!ok) unsub()
  } catch (err) {
    reportWindowError('openParseDialogWithFile', err)
  }
}

/**
 * T4-06/G（轮 G·3）：打开一个全新的「直接解析」进度窗（每轮一个独立窗口）。
 * 改为经 Rust 命令 lu_open_progress 创建带唯一 label（progress-N）的窗口并暂存待解析文件，
 * 进度窗挂载后自行取走——规避「上一轮未结束就开新一轮时刷新同一窗口」的问题。
 */
export async function openProgressWindow(filePaths: string[]): Promise<boolean> {
  if (!isTauri()) {
    log('debug', 'window', 'openProgressWindow.skip', { reason: 'not-tauri', fileCount: filePaths.length })
    return false
  }
  log('debug', 'window', 'openProgressWindow.enter', { fileCount: filePaths.length })
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const label = await invoke<string>('lu_open_progress', { filePaths })
    log('debug', 'window', 'openProgressWindow.ok', { label })
    return Boolean(label)
  } catch (err) {
    reportWindowError('openProgressWindow', err)
    log('error', 'window', 'openProgressWindow.error', { message: err instanceof Error ? err.message : String(err) })
    return false
  }
}

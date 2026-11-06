// Windows 长路径支持（OT-X to_long_path 语义：paths.py:88-110）
// MIT License — 改编自 MinerU-OCR-Tool（src/mineru_ocr_tool/paths.py:88-110，
// 许可证经 D-29 用户确认为 MIT；保留原始版权声明与 LICENSE）。

/** 是否为 Windows（Node 与浏览器均可用；Tauri v2 仅发布 Windows，D-01） */
export function isWindows(): boolean {
  if (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform ?? '')) return true
  if (typeof process !== 'undefined' && (process as { platform?: string }).platform === 'win32') return true
  return false
}

/**
 * 为超过 MAX_PATH(260) 的路径加 Win32 长路径前缀：
 * - 驱动器路径 → `\\?\C:\...`
 * - UNC 路径 → `\\?\UNC\server\share\...`
 * 非 Windows、空前缀或已带前缀时原样返回。
 *
 * 2026-10-22 修复（真联调暴露，与 Rust long_path 同语义）：`\\?\` verbatim 前缀下
 * Win32 不做路径规范化，`/` 不会转 `\`（`\\?\E:/x` 无效，os error 2）；
 * 故加前缀前先把 `/` 归一为 `\`。Node 侧 fs 本会自行归一化，此处保持一致并防回归。
 */
export function toLongPath(path: string): string {
  if (!isWindows() || !path) return path
  const absolute = path.replace(/\//g, '\\')
  if (absolute.startsWith('\\\\?\\')) return absolute
  if (absolute.startsWith('\\\\')) {
    return '\\\\?\\UNC\\' + absolute.slice(2)
  }
  return '\\\\?\\' + absolute
}

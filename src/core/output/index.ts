// M05 · core/output 桶文件

export { safeExtractZip, sanitizeZipPath } from './unzip'
export type { ZipLimits } from './unzip'
export { scanOutputs, firstMarkdown, pickFinalContentJson, locateOutputs } from './locate'
export {
  writeOutputs,
  sanitizeStem,
  sanitizeRelativePath,
  escapeReservedName,
  isReservedWindowsName,
  uniqueDirPath,
  stemOf,
  dirNameOf,
} from './write'
export { writebackReplace, writebackBoth, writebackMarkdown } from './writeback'

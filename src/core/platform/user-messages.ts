// core/platform · 用户消息映射（轮 G 日志重构 / T1·T3）
// 设计目标（见 plan/06 D-71）：把内部错误/事件 code 映射为「用户能看懂、无技术黑话」的通知（UserMessage）。
// 底部通知流（NotificationPanel）只展示用户需要知道/需要操作的；全量技术细节另走 logger（黑盒）。
// 本文件是纯函数映射，不依赖任何 UI；可被 core 与 UI 共用。文案为草稿，最终以用户确认为准（标记「待用户确认文案」）。

import type { BmuErrorKind } from '../types'

export type UserLevel = 'info' | 'success' | 'warn' | 'error'

export interface UserAction {
  label: string
  /** navigate=跳设置页某组；retry=触发重试；open-log=打开调试日志；open-url=打开链接 */
  kind: 'navigate' | 'retry' | 'open-log' | 'open-url'
  /** navigate 时为设置页分组 key（mineru/caption/output/general/log） */
  target?: string
}

export interface UserMessage {
  code: string
  level: UserLevel
  title: string
  detail?: string
  action?: UserAction
  /** 调试提示：仅写入调试日志，用户面板不展示；提示「可打开调试日志看技术细节」 */
  debugHint?: string
}

type Ctx = Record<string, unknown>

interface Entry {
  level: UserLevel
  title: string
  detail?: string
  action?: UserAction
  debugHint?: string
}

/** {var} 占位替换（detail 中引用 ctx 字段） */
function fill(tpl: string, ctx?: Ctx): string {
  if (!tpl.includes('{')) return tpl
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = ctx?.[k]
    return v === undefined || v === null ? '' : String(v)
  })
}

function build(
  level: UserLevel,
  title: string,
  opts?: { detail?: string; action?: UserAction; debugHint?: string },
): Entry {
  return { level, title, detail: opts?.detail, action: opts?.action, debugHint: opts?.debugHint }
}

// ---------------------------------------------------------------- 映射表（待用户确认文案）
// 注意：detail 中可用 {var} 引用 ctx；未提供时为空串。
const TABLE: Record<string, (ctx?: Ctx) => Entry> = {
  // ---- 鉴权 / 配额 / 网络 ----
  'mineru.auth.401': () =>
    build('error', 'MinerU 鉴权失败（HTTP 401）', {
      detail: 'Token 无效或已过期。请到「设置 → MinerU」重新填写有效的 Token。',
      action: { label: '去设置', kind: 'navigate', target: 'mineru' },
      debugHint: '服务端返回 401，检查 Token 是否正确/是否已过期。',
    }),
  'mineru.auth.failed': () =>
    build('error', 'MinerU 鉴权失败', {
      detail: 'Token 无效或已过期。请到「设置 → MinerU」重新填写有效的 Token。',
      action: { label: '去设置', kind: 'navigate', target: 'mineru' },
      debugHint: '服务端返回认证错误（A0202/A0211），检查 Token。',
    }),
  'mineru.token.missing': () =>
    build('warn', '未配置 MinerU Token', {
      detail: '尚未填写 Token，无法发起解析。请到「设置 → MinerU」填写有效的 Token。',
      action: { label: '去设置', kind: 'navigate', target: 'mineru' },
      debugHint: 'config.mineru.token 为空。',
    }),
  'mineru.quota.limit': (c) =>
    build('warn', '已达到 MinerU 使用上限', {
      detail: fill('本次请求被云端拒绝（{message}）。超过单文件限制时系统会自动拆分后重试；若仍失败请检查文件或稍后重试。', c),
      action: { label: '打开日志目录', kind: 'open-log' },
      debugHint: '服务端返回 -60005(>200MB)/-60006(>200页)/-60018(每日额度)；-60006 由 pipeline 自动拆分合并。',
    }),
  'network.timeout': (c) =>
    build('error', '网络超时', {
      detail: fill('请求在 {timeoutMs} 毫秒内未收到响应，可能是网络不稳或服务端繁忙。已自动重试，仍失败请稍后重试。', c),
      action: { label: '打开日志目录', kind: 'open-log' },
      debugHint: 'HTTP 请求超过 requestTimeoutMs/taskTimeoutMs。',
    }),
  'network.error': (c) =>
    build('error', '网络错误', {
      detail: fill('请求失败：{message}。请检查网络连接后重试。', c),
      action: { label: '打开日志目录', kind: 'open-log' },
      debugHint: 'HTTP 传输层错误（非超时）。',
    }),
  'mineru.business.error': (c) =>
    build('error', 'MinerU 解析失败', {
      detail: fill('服务端返回业务错误：{message}。', c),
      action: { label: '打开日志目录', kind: 'open-log' },
      debugHint: '业务码 != 0（如 -60001/-60008/-60009/-60012/-60013/-60017）。',
    }),
  'input.unsupported': (c) =>
    build('warn', '不支持的输入文件', {
      detail: fill('{file} 不是受支持的 PDF 文件，已跳过。', c),
      debugHint: 'D-14：非 PDF 在提交前被拦截。',
    }),
  'internal.error': (c) =>
    build('error', '程序内部错误', {
      detail: fill('处理 {file} 时出现内部错误：{message}。可重试；若持续出现请开启调试日志并提交反馈。', c),
      action: { label: '打开日志目录', kind: 'open-log' },
      debugHint: '未归类错误（internal）。',
    }),

  // ---- 存储 / 权限 ----
  'store.permission': () =>
    build('error', '历史记录不可用', {
      detail: 'SQLite 数据库初始化或写入失败（可能是权限或磁盘问题）。本次运行不保留历史，但解析仍可进行。',
      debugHint: 'store 初始化抛错，降级内存态。',
    }),
  'store.unavailable': (c) =>
    build('warn', '历史记录不可用', {
      detail: fill('{message} 本次运行的历史记录不会保存。', c),
      debugHint: '非 Tauri 或 SQLite 不可用，降级内存态。',
    }),

  // ---- 图片描述 ----
  'caption.not-configured': () =>
    build('warn', '图片描述未启用', {
      detail: '未配置多模态服务（API 地址或密钥），图片描述步骤已跳过。如需为图片生成描述，请到「设置 → 图片描述」填写。',
      action: { label: '去设置', kind: 'navigate', target: 'caption' },
      debugHint: '对应入口 captionEnabled=false 或 baseUrl/apiKey 为空。',
    }),
  'caption.failed': (c) =>
    build('warn', '图片描述失败', {
      detail: fill('部分图片描述失败（{message}），不影响已生成的解析结果。', c),
      action: { label: '打开日志目录', kind: 'open-log' },
      debugHint: 'rerunCaption 抛错（旁路步骤）。',
    }),
  // D-98：图片描述过程通报（开始 / 结束），让用户明确当前用的是哪个模型
  'caption.started': (c) =>
    build('info', '开始生成图片描述', {
      detail: fill('模型：{model}；目录：{dir}', c),
      debugHint: 'rerunCaption 入口；同一目录并发点击会被忽略。',
    }),
  'caption.finished': (c) =>
    build('success', '图片描述完成', {
      detail: fill('模型：{model}；成功 {described} 张，失败 {failed} 张。', c),
      debugHint: 'stats 来自 runCaption。',
    }),

  // ---- 拆分 / 批量 / 进度（过程型：简略=结果 title；详细=累计过程 detail）----
  // 导入文件：仅通知已加入队列（不做任何解析），标题「已导入」（#1：原误用 batch.progress 的「已开始处理」）
  'batch.imported': (c) =>
    build('info', '已导入', {
      detail: fill('{message}', c),
      debugHint: '文件加入等待队列（addPdfs）。',
    }),
  'batch.nothing': () =>
    build('info', '无可执行的文件', {
      detail: '当前没有待执行的导入文件，也没有未完成的任务文件。请先导入 PDF，或点击历史任务载入继续。',
      debugHint: 'startAll 时 pending 为空且当前任务无未终态文件。',
    }),
  // 自动拆分：精准模式由 -60006 或本地页数预判触发，Agent 模式由 >20 页触发；两者最后都合并为一份结果。
  'split.progress': () =>
    build('info', '正在自动拆分', {
      detail: 'PDF 超过页数上限，正在自动拆分为多个分片分别解析、最后合并为完整结果……',
      debugHint: 'pipeline 进入自动拆分分支（精准 runSplit / Agent runAgentSplit）。',
    }),
  'split.done': (c) =>
    build('success', '拆分解析完成', {
      detail: fill('已自动拆分为 {count} 个分片并合并为完整结果。', c),
      debugHint: '自动拆分合并完成（精准 runSplit / Agent runAgentSplit）。',
    }),
  'batch.progress': (c) =>
    build('info', '已开始处理', {
      detail: fill('{message}', c),
      debugHint: '批次进行中（同一批次用同一 id 累计）。',
    }),
  'batch.created': (c) =>
    build('success', '批次已创建', {
      detail: fill('任务 {task} 已创建，共 {count} 个文件入队。', c),
      debugHint: '批次创建入队完成。',
    }),
  'batch.done': (c) =>
    build('success', '批次完成', {
      detail: fill('{message}', c),
      debugHint: '批次终态（预留，当前由 batch.created 收口）。',
    }),
  'batch.stopped': () =>
    build('warn', '已停止', {
      detail: '运行中和等待中的文件已取消。',
      debugHint: 'stopAll 取消。',
    }),

  // ---- 重试（过程型）----
  'retry.progress': (c) =>
    build('info', '正在重试', {
      detail: fill('{message}', c),
      debugHint: 'retryTask 提交中。',
    }),
  'retry.success': (c) =>
    build('success', '重试成功', {
      detail: fill('{message}', c),
      debugHint: '重试成功提交。',
    }),
  'retry.failed': (c) =>
    build('error', '重试失败', {
      detail: fill('{message}', c),
      action: { label: '打开日志目录', kind: 'open-log' },
      debugHint: 'retryTask 抛错。',
    }),
  'retry.nothing': () =>
    build('info', '无可重试的文件', {
      detail: '当前任务没有失败的文件可重试。',
      debugHint: 'retryAllActive 找不到 failed 文件。',
    }),

  // ---- 窗口 / 输出 ----
  'window.open-failed': () =>
    build('error', '无法打开进度窗口', {
      detail: '已回退到主工作站处理。可手动点击「全部开始」。',
      debugHint: 'openProgressWindow 返回 false。',
    }),
  'open.failed': (c) =>
    build('warn', '打开失败', {
      detail: fill('无法打开：{message}。可手动定位文件。', c),
      debugHint: 'openPath 抛错。',
    }),

  // ---- 恢复 / 历史 ----
  'recover.done': (c) =>
    build('warn', '崩溃恢复', {
      detail: fill('{message}', c),
      debugHint: 'TaskManager.recover 标记中断/失败。',
    }),
  'history.deleted': () => build('info', '已删除历史记录', { debugHint: 'deleteBatch 完成。' }),
  'history.delete.failed': (c) =>
    build('error', '删除失败', {
      detail: fill('{message}', c),
      action: { label: '打开日志目录', kind: 'open-log' },
    }),

  // ---- 配置 ----
  'config.saved': () => build('success', '设置已保存', { debugHint: 'saveConfig 成功。' }),
  'config.save.failed': (c) =>
    build('error', '设置保存失败', {
      detail: fill('{message}', c),
      action: { label: '打开日志目录', kind: 'open-log' },
    }),

  // ---- 剪贴板 ----
  'clipboard.copied': () => build('info', '已复制到剪贴板', { debugHint: '日志复制成功。' }),
  'clipboard.failed': (c) =>
    build('warn', '复制失败', {
      detail: fill('{message}', c),
      debugHint: 'navigator.clipboard 不可用。',
    }),

  // ---- 通用兜底 ----
  'generic.error': (c) =>
    build('error', '出错了', {
      detail: fill('{message}', c),
      action: { label: '打开日志目录', kind: 'open-log' },
    }),
  'generic.info': (c) => build('info', fill('{message}', c), { debugHint: '通用信息通知。' }),
}

const FALLBACK: Entry = {
  level: 'error',
  title: '出现未知问题',
  detail: '请开启调试日志并提交反馈。',
  action: { label: '查看调试日志', kind: 'open-log' },
}

/** 把内部 code 映射为用户消息；未命中返回 null（调用方决定用兜底还是忽略）。 */
export function toUserMessage(code: string, ctx?: Ctx): UserMessage | null {
  const fn = TABLE[code]
  if (!fn) return null
  const e = fn(ctx)
  return { code, level: e.level, title: e.title, detail: e.detail, action: e.action, debugHint: e.debugHint }
}

/** 映射；未命中则用通用兜底（保证一定有用户消息）。 */
export function toUserMessageOrGeneric(code: string, ctx?: Ctx): UserMessage {
  return toUserMessage(code, ctx) ?? { code, ...FALLBACK }
}

/**
 * 把 BmuError 的错误类别映射为通知 code（供 core 在捕获处生成用户通知）。
 * 超时（transport 且消息含超时）单独映射到 network.timeout。
 */
export function errorKindToCode(kind: BmuErrorKind, ctx?: Ctx): string {
  switch (kind) {
    case 'auth':
      return 'mineru.auth.failed'
    case 'limit':
      return 'mineru.quota.limit'
    case 'transport':
      return /timeout|超时/i.test(String(ctx?.message ?? '')) ? 'network.timeout' : 'network.error'
    case 'business':
      return 'mineru.business.error'
    case 'unsupported':
      return 'input.unsupported'
    case 'canceled':
      // 用户主动取消，通常不弹出错误通知（调用方应跳过）
      return 'generic.info'
    case 'internal':
      return 'internal.error'
    default:
      return 'generic.error'
  }
}

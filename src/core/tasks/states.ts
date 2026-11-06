// core/tasks/states — 状态 → 本地展示态 + 文案（T3-11）
// 集中映射，便于联调补全（plan/04 P-1 state 全集 + 本地阶段态）。
// 未知 state 有兜底展示（warn 色 + 原始值回显）。

import type { JobStatus } from '../types'

export type StateTone = 'idle' | 'active' | 'success' | 'error' | 'warn'

export interface StateView {
  status: JobStatus
  label: string
  tone: StateTone
}

// 同时收纳服务端可能下发的 state（running/converting/waiting-file）与本地阶段态
// D-52 文案细化：未开始 / 解析中 / 转换中 / 成功 / 失败 / 已取消 / 已中断；未知态兜底回显原值。
const MAP: Record<string, StateView> = {
  // —— 本地阶段态 ——
  pending: { status: 'pending', label: '未开始', tone: 'idle' },
  uploading: { status: 'uploading', label: '解析中', tone: 'active' },
  polling: { status: 'polling', label: '解析中', tone: 'active' },
  downloading: { status: 'downloading', label: '解析中', tone: 'active' },
  extracting: { status: 'extracting', label: '解析中', tone: 'active' },
  writing: { status: 'writing', label: '解析中', tone: 'active' },
  done: { status: 'done', label: '成功', tone: 'success' },
  failed: { status: 'failed', label: '失败', tone: 'error' },
  canceled: { status: 'canceled', label: '已取消', tone: 'warn' },
  interrupted: { status: 'interrupted', label: '已中断', tone: 'warn' },
  // —— 服务端可能下发（plan/04 P-1）——
  running: { status: 'polling', label: '解析中', tone: 'active' },
  converting: { status: 'polling', label: '转换中', tone: 'active' },
  'waiting-file': { status: 'pending', label: '未开始', tone: 'idle' },
}

/** 取状态展示；未知状态兜底为 warn + 回显原始值 */
export function viewState(status: string): StateView {
  const hit = MAP[status]
  if (hit) return hit
  return {
    status: (status as JobStatus),
    label: `未知（${status}）`,
    tone: 'warn',
  }
}

// M04 · core/caption/normalize — 描述输出归一（T2-05）
// 原计划口径为 VS-X026/020 的「标签顺序归一」（_normalize_glm_output + GLM_LABELS：
// 确保 [TYPE]/[SUMMARY]/… 10 标签存在且顺序固定）。**该口径不适用于 V0.3**：
// T2-02 采用的基线 Prompt 是轻量单段描述（需求终版 §四），输出无标签结构，
// 照搬 10 标签会把描述撑爆（写回 alt/旁注只需一句话）。
// 本模块保留 T2-05 的**契约意图**——「输出始终确定性、可被程序消费」——
// 在无标签基线下降级为：清洗（一行化）+ 方括号全角化（防 [图片描述:…] 旁注歧义）+ 长度硬顶。
// 如未来恢复结构化标签输出（需用户决策），在此恢复标签归一实现。

import { cleanCaption } from '../client/multimodal'

/** 描述长度硬顶（字符）兜底。轮 J：提示词方案要求「不人为压缩」，放宽到 4000 防失控 */
export const MAX_DESCRIPTION_CHARS = 4000

/**
 * 归一单条描述（T2-05 适配版）：
 * 1. 复用 T2-01 清洗：去首尾空白、连续空白折叠为单空格、双引号→单引号（TS-X005）；
 * 2. ASCII 方括号 `[` `]` → 全角 `［］`（避免与 T2-09「两者都有」模式的 `[图片描述:…]` 旁注歧义）；
 * 3. 超长截断并加省略号（保证 alt/旁注单行可消费）；上限取 config.multimodal.maxDescriptionChars（T2-10）。
 * 输入为空串时返回空串（调用方按失败处理；T2-01 客户端已对空 content 抛 EMPTY_CAPTION）。
 */
export function normalizeDescription(raw: string, maxChars: number = MAX_DESCRIPTION_CHARS): string {
  let text = cleanCaption(raw)
  text = text.replace(/\[/g, '［').replace(/\]/g, '］')
  const limit = Number.isFinite(maxChars) && maxChars >= 4 ? Math.floor(maxChars) : MAX_DESCRIPTION_CHARS
  if (text.length > limit) {
    text = `${text.slice(0, limit - 1)}…`
  }
  return text
}

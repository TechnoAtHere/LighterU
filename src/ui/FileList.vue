<script setup lang="ts">
// 共享组件 · 进行中文件列表（T4-04/T4-11 复用；UI 规格 §2.3/§4.2 行形态）
// 轮 J 美化：文件名 + 状态 + 输出位置 + 行内操作（开始/停止/重试 · 图片解析 · 打开 · 刷新）。
import { onBeforeUnmount, ref, watch, type Directive } from "vue";
import type { CloudState, Job } from "../core/types";

/**
 * 仅当内容被截断（省略号生效）时才启用原生 title，悬停显示全文。
 * 与行内操作按钮的 title 提示体验一致，且未截断时不弹多余提示。
 * 监听列元素自身的尺寸变化（窗口拉伸 / 侧栏折叠均覆盖），保证 title 在悬停前已就绪。
 */
type TipEl = HTMLElement & { __luTip?: () => void; __luTipText?: string; __luTipObserver?: ResizeObserver };
const vTip: Directive<HTMLElement, string> = {
  mounted(el, binding) {
    const t = el as TipEl;
    t.__luTipText = binding.value ?? "";
    t.__luTip = () => {
      // +1 容忍亚像素误差，避免未截断时误判
      t.title = t.scrollWidth > t.clientWidth + 1 ? (t.__luTipText ?? "") : "";
    };
    t.__luTipObserver = new ResizeObserver(() => t.__luTip?.());
    t.__luTipObserver.observe(t);
    requestAnimationFrame(() => t.__luTip?.());
  },
  updated(el, binding) {
    const t = el as TipEl;
    t.__luTipText = binding.value ?? "";
    requestAnimationFrame(() => t.__luTip?.());
  },
  unmounted(el) {
    const t = el as TipEl;
    t.__luTipObserver?.disconnect();
    t.__luTip = undefined;
  },
};
import Icon from "./components/Icon.vue";

const props = defineProps<{
  files: Job[];
  taskId?: string | null;
  /** 图片解析执行器（工作站 / 进度窗分别注入）；signal 用于取消执行中的任务，返回是否成功 */
  captionRunner?: (job: Job, signal?: AbortSignal) => Promise<boolean>;
}>();

const emit = defineEmits<{
  (e: "retry", fileId: string): void;
  (e: "start", fileId: string): void;
  (e: "stop", fileId: string): void;
  (e: "refresh", fileId: string): void;
  (e: "editDir", fileId: string): void;
  (e: "open", job: Job): void;
}>();

// D-52 状态文案细化：未开始 / 解析中 / 转换中 / 成功 / 失败 / 已取消 / 已中断；未知态回显原值。
const STATUS_TEXT: Record<string, string> = {
  pending: "未开始",
  waiting: "未开始",
  uploading: "解析中",
  polling: "解析中",
  downloading: "解析中",
  extracting: "解析中",
  writing: "解析中",
  running: "解析中",
  converting: "转换中",
  done: "成功",
  failed: "失败",
  canceled: "已取消",
  interrupted: "已中断",
};

const TERMINAL = new Set(["done", "failed", "canceled", "interrupted"]);

/** 官方 v4 任务状态对应的文案：pending 排队中 / running 正在解析 / converting 格式转换中 / done / failed */
const CLOUD_STATE_TEXT: Record<CloudState, string> = {
  pending: "排队中",
  running: "正在解析",
  converting: "格式转换中",
  done: "完成",
  failed: "解析失败",
  unknown: "解析中",
};

function statusText(j: Job): string {
  const p = j.progress;
  if (isActive(j)) {
    // 自动拆分：主文案统一为「解析中」，括号内显示分片进度，如 解析中（1/4）
    if (p?.partTotal && p.partTotal > 1 && p.partIndex) {
      return `解析中（${p.partIndex}/${p.partTotal}）`;
    }
    // 非拆分：直接反映服务端返回的明确状态
    if (p?.cloudState && p.cloudState !== "unknown") {
      return CLOUD_STATE_TEXT[p.cloudState];
    }
  }
  return STATUS_TEXT[j.status] ?? j.status;
}
function statusClass(j: Job): string {
  if (j.status === "done") return "done";
  if (j.status === "failed") return "failed";
  if (j.status === "canceled" || j.status === "interrupted") return "canceled";
  if (j.status === "pending") return "wait";
  return "active";
}
function isActive(j: Job): boolean {
  return !TERMINAL.has(j.status);
}
function baseName(p: string): string {
  return p.replace(/^.*[\\/]/, "");
}
/** 状态列悬停全文：状态 + 页数进度 + 完整错误信息（失败时） */
function statusTip(j: Job): string {
  const p = j.progress;
  const pages = p?.totalPages ? `（已解析 ${p.extractedPages ?? 0}/${p.totalPages} 页）` : "";
  const err = j.error && j.status === "failed" ? ` — ${j.error}` : "";
  return `${statusText(j)}${pages}${err}`;
}
/** 输出目录列悬停全文 */
function outTip(j: Job): string {
  return j.destDirOverride ?? j.outputDir ?? "点击设置输出目录";
}

// 图片解析按钮状态：
// idle → queued(半蓝半淡蓝，等待文件解析完成) → running(全蓝，执行中) → done(绿，不动) / failed(红，可重试)
// queued / running 再次点击均为取消；done / failed 点击为重跑。
type CaptionState = "idle" | "queued" | "running" | "done" | "failed";
const captionStates = ref<Record<string, CaptionState>>({});
/** 每次执行对应一个 AbortController，用于真正中止在途请求，并防止已取消的执行回写终态 */
const captionControllers = new Map<string, AbortController>();

function captionState(job: Job): CaptionState {
  return captionStates.value[job.id] ?? "idle";
}
function setCaptionState(id: string, state: CaptionState): void {
  captionStates.value = { ...captionStates.value, [id]: state };
}

function captionTitle(job: Job): string {
  switch (captionState(job)) {
    case "queued": return "图片解析已排队（等待文件解析完成），点击取消";
    case "running": return "图片解析进行中，点击取消";
    case "failed": return "图片解析失败，点击重试";
    case "done": return "图片解析已完成，点击重跑";
    default: return "图片解析（使用当前提示词方案重跑）";
  }
}

async function runCaption(job: Job): Promise<void> {
  if (!props.captionRunner) {
    setCaptionState(job.id, "failed");
    return;
  }
  const controller = new AbortController();
  captionControllers.set(job.id, controller);
  setCaptionState(job.id, "running");
  let ok = false;
  try {
    ok = await props.captionRunner(job, controller.signal);
  } catch {
    ok = false;
  }
  // 仅当本次执行仍是当前执行时写终态：取消会移除 controller，重新点击会替换它。
  if (captionControllers.get(job.id) !== controller) return;
  captionControllers.delete(job.id);
  // 成功 → 绿（保持不动）；任何失败（未配置服务 / 调用失败 / 无图可读 / 抛错）→ 红。
  setCaptionState(job.id, ok ? "done" : "failed");
}

/** 取消排队，或中止执行中的图片解析；按钮复位为未触发 */
function cancelCaption(job: Job): void {
  captionControllers.get(job.id)?.abort();
  captionControllers.delete(job.id);
  setCaptionState(job.id, "idle");
}

/** 点击：排队 / 执行中 → 取消；其余 → 已解析完成立即执行，否则排队到解析完成 */
function triggerCaption(job: Job): void {
  if (!props.captionRunner) return;
  const state = captionState(job);
  if (state === "queued" || state === "running") {
    cancelCaption(job);
    return;
  }
  // 失败态（及已完成态）再次点击：直接重跑而非排队；再次失败仍停留红色
  if (state === "failed" || state === "done" || job.status === "done") {
    void runCaption(job);
  } else {
    setCaptionState(job.id, "queued");
  }
}

onBeforeUnmount(() => {
  for (const c of captionControllers.values()) c.abort();
  captionControllers.clear();
});

// 解析完成 → 自动执行排队的图片解析；解析失败/取消/中断 → 复位为未触发
watch(
  () => props.files.map((f) => `${f.id}:${f.status}`).join("|"),
  () => {
    for (const f of props.files) {
      if (captionState(f) !== "queued") continue;
      if (f.status === "done") void runCaption(f);
      else if (f.status === "failed") {
        // 已排队但文件解析失败 → 图片解析根本没能执行，同样给红色失败反馈
        setCaptionState(f.id, "failed");
      } else if (f.status === "canceled" || f.status === "interrupted") {
        // 用户主动取消/中断不算错误：复位为未触发，同时中止可能仍在途的图片解析
        cancelCaption(f);
      }
    }
  },
);
</script>

<template>
  <div class="filelist">
    <p v-if="files.length === 0" class="empty">暂无进行中文件</p>
    <div v-for="job in files" :key="job.id" class="prow">
      <span class="p-name" v-tip="job.inputPath">{{ baseName(job.inputPath) }}</span>
      <span class="p-status" :class="statusClass(job)" v-tip="statusTip(job)">
        {{ statusText(job) }}<template v-if="job.error && job.status === 'failed'"> — {{ job.error }}</template>
      </span>
      <span class="p-out" v-tip="outTip(job)" @click="emit('editDir', job.id)">
        {{ job.destDirOverride ?? job.outputDir ?? "点击设置目录" }}
      </span>
      <span class="p-ops">
        <button v-if="isActive(job)" class="icon-mini" title="停止" @click="emit('stop', job.id)">
          <Icon name="pause" :size="14" />
        </button>
        <button v-else-if="job.status === 'failed'" class="icon-mini" title="重试" @click="emit('retry', job.id)">
          <Icon name="repeat" :size="14" />
        </button>
        <button v-else class="icon-mini" title="开始" @click="emit('start', job.id)">
          <Icon name="play" :size="14" />
        </button>
        <button
          v-if="captionRunner"
          class="icon-mini caption-btn"
          :class="{
            'caption-queued': captionState(job) === 'queued',
            'caption-running': captionState(job) === 'running',
            'caption-done': captionState(job) === 'done',
            'caption-failed': captionState(job) === 'failed',
          }"
          :title="captionTitle(job)"
          @click="triggerCaption(job)"
        >图</button>
        <button class="icon-mini" title="打开" @click="emit('open', job)">
          <Icon name="square-arrow-out-up-right" :size="14" />
        </button>
        <button class="icon-mini" title="刷新" @click="emit('refresh', job.id)">
          <Icon name="rotate-ccw" :size="14" />
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.filelist {
  display: flex;
  flex-direction: column;
}
.empty {
  margin: 0;
  padding: 28px 14px;
  font-size: 12px;
  color: #9aa3af;
  text-align: center;
}
.prow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  font-size: 13px;
  border-bottom: 1px solid #f1f3f5;
}
.prow:last-child {
  border-bottom: none;
}
.prow:hover {
  background: #f8fbff;
}
/* 三列均可随窗口拉伸（flex-grow:1），并按字符数设下限；ch 随各自字号自适应。 */
.p-name {
  flex: 1 1 34%;
  min-width: 4ch; /* 名称至少 4 个字符 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #1f2937;
  font-weight: 500;
}
.p-status {
  flex: 1 1 22%;
  min-width: 2ch; /* 状态至少 2 个字符 */
  font-size: 12px;
  font-weight: 600;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-status.active {
  color: var(--lu-primary, #0e8afe);
}
.p-status.done {
  color: var(--lu-success-ink, #009e80);
  font-weight: 700;
}
.p-status.failed {
  color: var(--lu-danger, #f04f75);
}
.p-status.canceled {
  color: var(--lu-warning, #f7903d);
}
.p-out {
  flex: 1 1 44%;
  min-width: 4ch; /* 目录至少 4 个字符 */
  font-size: 12px;
  color: #8a94a6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.p-out:hover {
  color: var(--lu-primary, #0e8afe);
}
.p-ops {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.icon-mini {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  color: #4b5563;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.icon-mini:hover {
  border-color: var(--lu-primary, #0e8afe);
  color: var(--lu-primary, #0e8afe);
  background: #f2f8ff;
}
/* 图片解析按钮状态：
   - 排队：对角线切一刀，一半主蓝一半淡蓝，白字（135deg 硬边界）
   - 执行中：整块主蓝，白字
   - 完成：绿且保持不动；失败：红，可点击重试 */
.icon-mini.caption-queued {
  border-color: var(--lu-primary, #0e8afe);
  background: linear-gradient(135deg, var(--lu-primary, #0e8afe) 0 50%, #8ec5ff 50% 100%);
  color: #fff;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.28);
}
.icon-mini.caption-running {
  border-color: var(--lu-primary, #0e8afe);
  background: var(--lu-primary, #0e8afe);
  color: #fff;
}
.icon-mini.caption-done {
  border-color: var(--lu-success-ink, #009e80);
  background: var(--lu-success-ink, #009e80);
  color: #fff;
}
.icon-mini.caption-failed {
  border-color: var(--lu-danger, #f04f75);
  background: var(--lu-danger, #f04f75);
  color: #fff;
}
@media (prefers-color-scheme: dark) {
  .prow {
    border-bottom-color: #2c2c2c;
  }
  .prow:hover {
    background: #202b3a;
  }
  .p-name {
    color: #e8e8e8;
  }
  .p-status,
  .p-out {
    color: #9aa3af;
  }
  .icon-mini {
    background: #2c2c2c;
    border-color: #444;
    color: #cbd5e1;
  }
}
</style>

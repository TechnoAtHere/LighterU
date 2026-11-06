<script setup lang="ts">
// 共享组件 · 进行中文件列表（T4-04/T4-11 复用；UI 规格 §2.3/§4.2 行形态）
// 轮 J 美化：文件名 + 状态 + 输出位置 + 行内操作（开始/停止/重试 · 图片解析 · 打开 · 刷新）。
import { ref, watch } from "vue";
import type { Job } from "../core/types";
import Icon from "./components/Icon.vue";

const props = defineProps<{
  files: Job[];
  taskId?: string | null;
  /** 图片解析执行器（工作站 / 进度窗分别注入）；返回是否成功 */
  captionRunner?: (job: Job) => Promise<boolean>;
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

function statusText(j: Job): string {
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

// 图片解析按钮状态：idle → queued(蓝) → running(蓝) → done(绿)
type CaptionState = "idle" | "queued" | "running" | "done";
const captionStates = ref<Record<string, CaptionState>>({});

function captionState(job: Job): CaptionState {
  return captionStates.value[job.id] ?? "idle";
}
function setCaptionState(id: string, state: CaptionState): void {
  captionStates.value = { ...captionStates.value, [id]: state };
}

async function runCaption(job: Job): Promise<void> {
  if (!props.captionRunner) return;
  setCaptionState(job.id, "running");
  let ok = false;
  try {
    ok = await props.captionRunner(job);
  } catch {
    ok = false;
  }
  // 成功 → 绿；失败保持蓝色，便于再次点击重试
  setCaptionState(job.id, ok ? "done" : "queued");
}

/** 任意时刻点击：立即变蓝；已解析完成则马上执行，否则排队到解析完成 */
function triggerCaption(job: Job): void {
  if (!props.captionRunner) return;
  if (captionState(job) === "running") return;
  if (job.status === "done") {
    void runCaption(job);
  } else {
    setCaptionState(job.id, "queued");
  }
}

// 解析完成 → 自动执行排队的图片解析；解析失败/取消/中断 → 复位为未触发
watch(
  () => props.files.map((f) => `${f.id}:${f.status}`).join("|"),
  () => {
    for (const f of props.files) {
      if (captionState(f) !== "queued") continue;
      if (f.status === "done") void runCaption(f);
      else if (f.status === "failed" || f.status === "canceled" || f.status === "interrupted") {
        setCaptionState(f.id, "idle");
      }
    }
  },
);
</script>

<template>
  <div class="filelist">
    <p v-if="files.length === 0" class="empty">暂无进行中文件</p>
    <div v-for="job in files" :key="job.id" class="prow">
      <span class="p-name" :title="job.inputPath">{{ baseName(job.inputPath) }}</span>
      <span class="p-status" :class="statusClass(job)">
        {{ statusText(job) }}<template v-if="job.error && job.status === 'failed'"> — {{ job.error }}</template>
      </span>
      <span class="p-out" :title="job.destDirOverride ?? job.outputDir ?? '点击设置输出目录'" @click="emit('editDir', job.id)">
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
            'caption-queued': captionState(job) === 'queued' || captionState(job) === 'running',
            'caption-done': captionState(job) === 'done',
          }"
          title="图片解析（使用当前提示词方案重跑）"
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
.p-name {
  flex: 0 1 34%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #1f2937;
  font-weight: 500;
}
.p-status {
  flex: 0 0 64px;
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
  flex: 1;
  min-width: 0;
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
/* 图片解析：已点击（排队/执行中）= 蓝；完成 = 绿 */
.icon-mini.caption-queued {
  border-color: var(--lu-primary, #0e8afe);
  background: var(--lu-primary, #0e8afe);
  color: #fff;
}
.icon-mini.caption-done {
  border-color: var(--lu-success-ink, #009e80);
  background: var(--lu-success-ink, #009e80);
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

<script setup lang="ts">
// D.11 日志查看/导出入口（T4 复用组件）：从 logger 内存缓冲读取链路日志，支持级别过滤、
// 调试开关、复制、导出到日志目录、打开日志目录。不改任何业务逻辑；仅新增调试入口。
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { getLogs, getLogText, getLogDir, setDebugEnabled, isDebugEnabled, clearLogs, type LogEntry, type LogLevel } from "../core/platform/logger";
import { scrubSecrets } from "../core/client/logmask";
import { isTauri } from "../core/platform/env";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

const filter = ref<"all" | "info" | "warn" | "error">("all");
const debugOn = ref(isDebugEnabled());
const lines = ref<string[]>([]);
const message = ref("");
const box = ref<HTMLDivElement | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

function minLevel(): number {
  if (filter.value === "all") return 0;
  if (filter.value === "info") return 2;
  if (filter.value === "warn") return 3;
  return 4;
}

function refresh(): void {
  const el = box.value;
  // 仅当用户已在底部附近时才自动滚动到底，避免把正在往上翻的用户拉回（T5-F）
  const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const m = minLevel();
  const out: string[] = [];
  for (const e of getLogs() as LogEntry[]) {
    if (LEVEL_RANK[e.level] < m) continue;
    out.push(scrubSecrets(JSON.stringify(e)));
  }
  lines.value = out;
  if (el && atBottom) {
    void nextTick(() => {
      if (box.value) box.value.scrollTop = box.value.scrollHeight;
    });
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      refresh();
      if (timer == null) timer = setInterval(refresh, 600);
    } else if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  },
);

onBeforeUnmount(() => {
  if (timer != null) clearInterval(timer);
});

function close(): void {
  emit("close");
}

function onFilter(f: "all" | "info" | "warn" | "error"): void {
  filter.value = f;
  refresh();
}

function toggleDebug(): void {
  debugOn.value = !debugOn.value;
  setDebugEnabled(debugOn.value);
  message.value = `调试日志已${debugOn.value ? "开启" : "关闭"}`;
}

async function copyAll(): Promise<void> {
  const text = lines.value.join("\n") + (lines.value.length ? "\n" : "");
  try {
    await navigator.clipboard.writeText(text);
    message.value = `已复制 ${lines.value.length} 行到剪贴板`;
  } catch {
    message.value = "复制失败（剪贴板不可用），请用「导出」";
  }
}

function exportText(): string {
  return getLogText();
}

async function exportFile(): Promise<void> {
  if (!isTauri()) {
    message.value = "当前非 Tauri 环境，请用「复制」";
    return;
  }
  const text = exportText();
  if (!text) {
    message.value = "暂无可导出的日志";
    return;
  }
  try {
    const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
    const dir = getLogDir();
    if (!dir) {
      message.value = "日志目录不可用";
      return;
    }
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${dir}/lu-export-${stamp}.log`;
    await writeTextFile(path, text);
    message.value = `已导出到 ${path}`;
  } catch (err) {
    message.value = `导出失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

async function openLogDir(): Promise<void> {
  const dir = getLogDir();
  if (!dir) {
    message.value = "日志目录不可用（非 Tauri 或未初始化）";
    return;
  }
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(dir);
  } catch (err) {
    message.value = `打开目录失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

async function clearAll(): Promise<void> {
  const n = await clearLogs();
  refresh();
  message.value = `已清空调试日志（内存与磁盘，删除 ${n} 个文件）`;
}
</script>

<template>
  <div v-if="visible" class="lv-backdrop" @click.self="close">
    <div class="lv-panel">
      <div class="lv-head">
        <span class="lv-title">链路日志</span>
        <div class="lv-tools">
          <button class="lv-btn" :class="{ active: filter === 'all' }" @click="onFilter('all')">全部</button>
          <button class="lv-btn" :class="{ active: filter === 'info' }" @click="onFilter('info')">信息+</button>
          <button class="lv-btn" :class="{ active: filter === 'warn' }" @click="onFilter('warn')">警告+</button>
          <button class="lv-btn" :class="{ active: filter === 'error' }" @click="onFilter('error')">错误</button>
          <label class="lv-dbg"><input type="checkbox" :checked="debugOn" @change="toggleDebug" /> 调试</label>
          <button class="lv-btn" @click="copyAll">复制</button>
          <button class="lv-btn" @click="exportFile">导出</button>
          <button class="lv-btn" @click="openLogDir">打开目录</button>
          <button class="lv-btn" @click="clearAll">清空</button>
          <button class="lv-btn close" @click="close">关闭</button>
        </div>
      </div>
      <div v-if="message" class="lv-msg">{{ message }}</div>
      <div ref="box" class="lv-body">
        <p v-if="lines.length === 0" class="lv-empty">暂无日志（点击开始 / 右键直接解析以产生链路日志）</p>
        <p v-for="(l, i) in lines" :key="i" class="lv-line">{{ l }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lv-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.lv-panel {
  width: min(880px, 92vw);
  height: min(620px, 86vh);
  background: #ffffff;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.lv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid #e5e5e5;
  flex-wrap: wrap;
}
.lv-title {
  font-size: 15px;
  font-weight: 600;
}
.lv-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.lv-btn {
  border: 1px solid #d4d4d4;
  background: #fff;
  border-radius: 8px;
  padding: 0.3em 0.7em;
  font-size: 12px;
  cursor: pointer;
}
.lv-btn.active {
  background: var(--lu-primary, #0e8afe);
  border-color: var(--lu-primary, #0e8afe);
  color: #fff;
}
.lv-btn.close {
  border-color: var(--lu-danger, #f04f75);
  color: var(--lu-danger, #f04f75);
}
.lv-dbg {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: #555;
}
.lv-msg {
  padding: 6px 14px;
  font-size: 12px;
  color: var(--lu-success-ink, #009e80);
  background: #f3faf5;
}
.lv-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: #0f0f0f;
}
.lv-line {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.lv-empty {
  color: #999;
  margin: 0;
}
@media (prefers-color-scheme: dark) {
  .lv-panel {
    background: #1f1f1f;
    color: #f6f6f6;
  }
  .lv-head {
    border-bottom-color: #3a3a3a;
  }
  .lv-btn {
    background: #2c2c2c;
    border-color: #444;
    color: #f6f6f6;
  }
  .lv-btn.active {
    background: var(--lu-primary, #0e8afe);
    border-color: var(--lu-primary, #0e8afe);
    color: #fff;
  }
  .lv-btn.close {
    border-color: var(--lu-danger, #f04f75);
    color: #ff8a8a;
  }
  .lv-dbg {
    color: #aaa;
  }
  .lv-body {
    color: #ddd;
  }
}
</style>

<script setup lang="ts">
// T4-11 「解析…」模态小窗（UI 规格 §4）：独立入口，自带 TaskManager + store，经 lu: 事件与主工作站同步显示。
// 顶栏：打开工作站 / 设置(占位) / 开始-停止；主体：进行中列表（复用 FileList）。不自动关闭。
// 右键「解析…」传入文件属轮 D（T4-01/T4-09）；本轮小窗内可自行导入文件联调。
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { TaskManager } from "../../core/tasks";
import { loadConfig } from "../../core/config";
import { createConfigStore } from "../../core/platform/store";
import { createSecretsAdapter } from "../../core/platform/secrets";
import { createSqlAdapter } from "../../core/platform/sql";
import { createStore } from "../../core/store";
import { resolveCaptionEnabled } from "../../core/caption";
import { isTauri } from "../../core/platform/env";
import { onTaskStatus } from "../../core/platform/events";
import FileList from "../FileList.vue";
import type { Store } from "../../core/store";
import type { Job } from "../../core/types";

// D.10：manager 用 shallowRef（同 App.vue / Progress.vue），避免 TaskManager 被深度 reactivize 后 config 变 Proxy 导致持久化克隆失败。
const manager = shallowRef<TaskManager | null>(null);
const storeRef = ref<Store | null>(null);
const pending = ref<string[]>([]);
const active = ref<Record<string, Job>>({});
const currentTaskId = ref<string | null>(null);
const busy = ref(false);
const notice = ref("");
let unEvents: Array<() => void> = [];

const TERMINAL = new Set(["done", "failed", "canceled", "interrupted"]);

onMounted(async () => {
  try {
    const config = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
    let store: Store | undefined;
    if (isTauri()) {
      try {
        const sql = await createSqlAdapter("sqlite:app.db");
        store = createStore(sql);
        await store.initSchema();
      } catch {
        store = undefined;
      }
    }
    storeRef.value = store ?? null;
    manager.value = new TaskManager(config, store);
    unEvents.push(
      onTaskStatus((p) => {
        const tm = manager.value;
        if (!tm || !p.fileId) return;
        const job = tm.getJob(p.fileId);
        if (job) active.value = { ...active.value, [p.fileId]: { ...job } };
        if (p.taskId === currentTaskId.value) {
          const info = tm.getTaskInfo(p.taskId);
          if (info && TERMINAL.has(info.status)) busy.value = false;
        }
      }),
    );
    // T4-03：接收主站/CLI 传入的文件（--parse-to）
    if (isTauri()) {
      try {
        const { emit, listen } = await import("@tauri-apps/api/event");
        const un = await listen<{ filePath: string }>("lu:dialog-file", (e) => {
          const p = e.payload.filePath;
          if (p && p.toLowerCase().endsWith(".pdf") && !pending.value.includes(p)) {
            pending.value = [...pending.value, p];
            notice.value = "已接收文件，点「开始」执行（可在列表设输出目录）";
          }
        });
        unEvents.push(un);
        await emit("lu:dialog-ready");
      } catch {
        // 忽略
      }
    }
  } catch (err) {
    notice.value = `初始化失败：${err instanceof Error ? err.message : String(err)}`;
  }
});

onBeforeUnmount(() => {
  for (const off of unEvents) off();
  unEvents = [];
});

async function pickFiles(): Promise<void> {
  const selected = await open({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!selected) return;
  const list = Array.isArray(selected) ? selected : [selected];
  const pdfs = list.filter((p) => p.toLowerCase().endsWith(".pdf"));
  pending.value = [...pending.value, ...pdfs.filter((p) => !pending.value.includes(p))];
}

function removePending(target: string): void {
  pending.value = pending.value.filter((f) => f !== target);
}

async function start(): Promise<void> {
  const tm = manager.value;
  if (!tm || pending.value.length === 0 || busy.value) return;
  const cfg = tm.getConfig();
  const taskId = await tm.createTask(pending.value, { captionEnabled: resolveCaptionEnabled(cfg.output[cfg.output.entry === "context-menu" ? "rightClick" : "workbench"].captionEnabled, undefined), processingLocation: "workbench" });
  currentTaskId.value = taskId;
  const next = { ...active.value };
  for (const f of tm.taskFiles(taskId)) next[f.id] = { ...f };
  active.value = next;
  pending.value = [];
  busy.value = true;
  await tm.submitAll(taskId);
}

function stop(): void {
  const tm = manager.value;
  if (tm && currentTaskId.value) tm.cancel(currentTaskId.value);
}

function retry(fileId: string): void {
  const tm = manager.value;
  if (tm && currentTaskId.value) void tm.retryFile(currentTaskId.value, fileId);
}

/** D-43：打开直达 full.md，否则目录 */
async function onOpen(job: Job): Promise<void> {
  const target = job.markdownPath ?? job.outputDir;
  if (!target) return;
  try {
    await openPath(target);
  } catch {
    // 忽略
  }
}

/** D-42：行内修改输出目录（下次执行生效） */
async function onEditDir(fileId: string): Promise<void> {
  const tm = manager.value;
  if (!tm) return;
  const job = tm.getJob(fileId);
  if (!job) return;
  const dir = await open({ directory: true, defaultPath: job.destDirOverride ?? job.outputDir ?? undefined });
  if (!dir || typeof dir !== "string") return;
  job.destDirOverride = dir;
  active.value = { ...active.value, [fileId]: { ...job } };
  notice.value = `输出目录已设为 ${dir}（下次执行生效）`;
}

async function openWorkbench(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const main = await WebviewWindow.getByLabel("main");
    if (main) {
      await main.show();
      await main.setFocus();
    }
  } catch {
    // 忽略
  }
}

function settings(): void {
  notice.value = "设置页将在阶段 5 实现";
}

const activeList = (): Job[] => Object.values(active.value).sort((a, b) => a.createdAt - b.createdAt);
</script>

<template>
  <main class="dialog">
    <header class="dlg-top">
      <div class="dlg-left">
        <span class="dlg-icon">⛏</span>
        <button class="tb-btn" @click="openWorkbench">打开工作站</button>
      </div>
      <div class="dlg-mid">
        <button class="tb-btn" @click="settings">设置</button>
      </div>
      <div class="dlg-right">
        <button :disabled="busy" @click="pickFiles">导入</button>
        <button class="primary" :disabled="!busy && pending.length === 0" @click="busy ? stop() : start()">
          {{ busy ? "停止" : "开始" }}
        </button>
      </div>
    </header>

    <section class="dlg-body">
      <div v-if="pending.length > 0" class="waiting">
        <span class="w-title">等待开始（{{ pending.length }}）</span>
        <span v-for="(f, i) in pending" :key="f" class="w-item">
          {{ i + 1 }}. {{ f.replace(/^.*[\\/]/, "") }}
          <button class="link" :disabled="busy" @click="removePending(f)">×</button>
        </span>
      </div>
      <FileList :files="activeList()" :task-id="currentTaskId" @retry="retry" @edit-dir="onEditDir" @open="onOpen" />
      <p v-if="notice" class="notice">{{ notice }}</p>
    </section>
  </main>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  text-align: left;
  color: #0f0f0f;
}
.dlg-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid #e5e5e5;
  flex-shrink: 0;
}
.dlg-left,
.dlg-mid,
.dlg-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dlg-icon {
  font-size: 18px;
}
.dlg-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.waiting {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  border-bottom: 1px solid #f0f0f0;
}
.w-title {
  font-weight: 600;
  color: #555;
}
.w-item {
  color: #666;
}
.notice {
  font-size: 12px;
  color: var(--lu-warning, #f7903d);
  padding: 6px 10px;
  margin: 0;
}
button {
  border-radius: 8px;
  border: 1px solid #d4d4d4;
  padding: 0.4em 0.9em;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  background: #ffffff;
  color: #0f0f0f;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.primary {
  background-color: var(--lu-primary, #0e8afe);
  border-color: var(--lu-primary, #0e8afe);
  color: #ffffff;
}
button.tb-btn {
  border-radius: 8px;
  border: 1px solid #d4d4d4;
  padding: 0.35em 0.8em;
  font-size: 13px;
  cursor: pointer;
  background: #ffffff;
  color: #0f0f0f;
}
button.link {
  border: none;
  background: none;
  color: var(--lu-primary, #0e8afe);
  padding: 2px 6px;
  font-size: 12px;
}
@media (prefers-color-scheme: dark) {
  .dialog {
    color: #f6f6f6;
  }
  .dlg-top {
    border-bottom-color: #3a3a3a;
  }
  button,
  button.tb-btn {
    background-color: #2c2c2c;
    border-color: #444;
    color: #f6f6f6;
  }
  .waiting {
    border-bottom-color: #2c2c2c;
  }
}
</style>

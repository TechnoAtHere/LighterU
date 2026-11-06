<script setup lang="ts">
// T4-06/D.8 轻量进度窗（UI 规格 §5）：右键「直接解析」打开；D.8 重做为**多文件**进度窗
// （本质是工作站的进度组件，复用 FileList 行形态）。
// 生命周期：mount → 监听 lu:direct-parse{filePaths} → createTask(N 文件) + submitAll 自动开始
// → 经 TaskManager 订阅同步显示 → 全终态按 output.autoCloseProgress 自动关闭。
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
import { hasMultimodalConfig, runJobCaption } from "../../core/caption/manual";
import { isTauri } from "../../core/platform/env";
import { log } from "../../core/platform/logger";
import FileList from "../FileList.vue";
import type { Store } from "../../core/store";
import type { AppConfig, Job } from "../../core/types";

// D.10：与 App.vue 一致——manager 用 shallowRef，避免 TaskManager 被深度 reactivize（config 变 Proxy 后持久化克隆失败）。
const manager = shallowRef<TaskManager | null>(null);
const taskId = ref<string | null>(null);
const files = ref<Job[]>([]);
const errorMsg = ref("");
const refreshing = ref(false);
/** 正在执行的图片解析数量：>0 时暂停自动关闭 */
const captionBusy = ref(0);
let cfg: AppConfig | null = null;
let unSub: (() => void) | null = null;
let unEvents: Array<() => void> = [];
let autoCloseTimer: number | null = null;
/** G·3：本窗 label（用于经 Rust 命令关闭/销毁本窗，避免依赖 JS 关闭权限） */
let myLabel = "";
/** G·3：防止经事件 + 状态两条路径重复启动同一窗口的解析 */
let started = false;
function beginParse(paths: string[]): void {
  if (started || paths.length === 0) return;
  started = true;
  void startParse(paths);
}

const TERMINAL = new Set(["done", "failed", "canceled", "interrupted"]);

/** G·诊断：若挂载后迟迟未收到文件，显示本窗 label，便于排查「空白」是路由问题还是未收到文件。 */
const staleHint = ref("");
let staleTimer: number | null = null;

function syncFiles(): void {
  const tm = manager.value;
  const id = taskId.value;
  if (!tm || !id) return;
  files.value = tm.taskFiles(id).map((f) => ({ ...f }));
  maybeAutoClose();
}

function allTerminal(): boolean {
  return files.value.length > 0 && files.value.every((f) => TERMINAL.has(f.status));
}
function hasActive(): boolean {
  return files.value.some((f) => !TERMINAL.has(f.status));
}

/** 任一文件失败/中断都不算「顺利结束」 */
function anyFailed(): boolean {
  return files.value.some((f) => f.status === "failed" || f.status === "interrupted");
}

function maybeAutoClose(): void {
  if (!cfg?.output.autoCloseProgress) return;
  if (!allTerminal() || captionBusy.value > 0) return;
  if (anyFailed()) {
    // 有文件失败：不自动关闭，保留窗口让用户查看/重试（并取消已排定的关闭）
    if (autoCloseTimer != null) {
      window.clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
    return;
  }
  if (autoCloseTimer != null) return;
  autoCloseTimer = window.setTimeout(() => void closeWindow(), 2000);
}

onMounted(async () => {
  try {
    const config = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
    cfg = config;
    log("info", "progress", "mount");
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
    const tm = new TaskManager(config, store);
    manager.value = tm;
    unSub = tm.subscribe(() => syncFiles());

    // 诊断：挂载后 1.5s 仍未收到文件 → 显示本窗 label，便于确认路由正确（G·空白排查）
    staleTimer = window.setTimeout(() => {
      if (!started && !errorMsg.value) staleHint.value = `本窗口未收到文件（label=${myLabel || "未知"}，已就绪等待中）`;
    }, 1500);

    // 兜底握手（保留）：兼容经事件直传的场景；优先使用 Rust 状态暂存取文件（G·3，按 label 隔离）
    const { emit, listen } = await import("@tauri-apps/api/event");
    const un = await listen<{ filePaths: string[] }>("lu:direct-parse", (e) => {
      const paths = e.payload.filePaths ?? [];
      log("info", "progress", "directParse", { fileCount: paths.length });
      beginParse(paths);
    });
    unEvents.push(un);
    await emit("lu:progress-ready");
    log("debug", "progress", "ready");

    // G·3：本窗专属待解析文件（Rust 状态暂存，按 window label 隔离，规避多窗竞态）
    if (isTauri()) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { invoke } = await import("@tauri-apps/api/core");
        myLabel = getCurrentWindow().label;
        log("info", "progress", "label", { label: myLabel });
        const pending = await invoke<Array<string> | null>("lu_take_progress_files", { label: myLabel });
        if (pending && pending.length > 0) {
          log("info", "progress", "takeFiles", { label: myLabel, fileCount: pending.length });
          beginParse(pending);
        }
      } catch (err) {
        log("warn", "progress", "takeFiles.failed", { message: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    errorMsg.value = `初始化失败：${err instanceof Error ? err.message : String(err)}`;
  }
});

onBeforeUnmount(() => {
  unSub?.();
  for (const off of unEvents) off();
  if (autoCloseTimer != null) window.clearTimeout(autoCloseTimer);
  if (staleTimer != null) window.clearTimeout(staleTimer);
});

async function startParse(filePaths: string[]): Promise<void> {
  const tm = manager.value;
  if (!tm || filePaths.length === 0) return;
  errorMsg.value = "";
  // T5-F：热加载最新配置（设置可能在主窗口改过；进度窗常驻，需每次重载并应用到 TaskManager）
  try {
    const fresh = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
    cfg = fresh;
    tm.applyConfig(fresh);
  } catch {
    // 重载失败则沿用挂载时的 cfg
  }
  const captionEnabled = resolveCaptionEnabled(
    cfg?.output[cfg.output.entry === "context-menu" ? "rightClick" : "workbench"].captionEnabled ?? false,
    undefined,
  );
  // T5-02/D-62：右键入口输出行为（格式/描述写入/同名/目录/自动打开）
  const rc = cfg?.output.rightClick;
  const id = await tm.createTask(filePaths, {
    captionEnabled,
    processingLocation: "inplace",
    format: rc?.format,
    outputs: rc?.outputs,
    captionMode: rc?.captionMode,
    sameNameHandling: cfg?.output.sameNameHandling,
    destDir: rc?.defaultDir,
    autoOpen: rc?.autoOpen,
  });
  taskId.value = id;
  syncFiles();
  // 「直接解析」语义：立即开始（不等用户点开始）；一次提交全部文件（并发，上限 50）
  await tm.submitAll(id, Math.min(filePaths.length, 50));
  log("info", "progress", "startParse", { taskId: id, count: filePaths.length });
}

function cancelAll(): void {
  const tm = manager.value;
  if (tm && taskId.value) {
    tm.cancel(taskId.value);
    tm.clearQueue();
    syncFiles();
  }
}

function manualRefresh(): void {
  const tm = manager.value;
  const id = taskId.value;
  if (!tm || !id) return;
  refreshing.value = true;
  files.value = tm.refreshStatus(id);
  window.setTimeout(() => {
    refreshing.value = false;
  }, 1000);
}

async function onFileRetry(fileId: string): Promise<void> {
  const tm = manager.value;
  const id = taskId.value;
  if (!tm || !id) return;
  try {
    await tm.retryFile(id, fileId);
    syncFiles();
  } catch {
    // 忽略（达到重试上限等）
  }
}

async function onFileEditDir(fileId: string): Promise<void> {
  const tm = manager.value;
  if (!tm) return;
  const job = tm.getJob(fileId);
  if (!job) return;
  const dir = await open({ directory: true, defaultPath: job.destDirOverride ?? job.outputDir ?? undefined });
  if (!dir || typeof dir !== "string") return;
  job.destDirOverride = dir;
  syncFiles();
}

async function onFileOpen(job: Job): Promise<void> {
  const target = job.markdownPath ?? job.outputDir;
  if (!target) return;
  try {
    await openPath(target);
  } catch {
    // 忽略
  }
}

async function openDir(): Promise<void> {
  const withOut = files.value.find((f) => f.outputDir);
  if (withOut?.outputDir) {
    try {
      await openPath(withOut.outputDir);
    } catch {
      // 忽略
    }
  }
}

/** 行内「图片解析」：对单个文件的输出目录重跑描述（进度窗与工作站共用执行器）。 */
async function onFileCaption(job: Job): Promise<boolean> {
  if (!job.outputDir) return false;
  const tm = manager.value;
  let config = cfg;
  // 设置可能刚在主窗口改过：点击时重载一次，避免用启动快照请求旧服务商
  try {
    const fresh = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
    cfg = fresh;
    config = fresh;
    tm?.applyConfig(fresh);
  } catch {
    config = tm?.getConfig() ?? cfg;
  }
  if (!config) return false;
  if (!hasMultimodalConfig(config)) {
    log("warn", "caption", "manual.skip", { reason: "not-configured", dir: job.outputDir });
    return false;
  }
  // 图片解析期间不自动关窗；并取消已排定的自动关闭
  if (autoCloseTimer != null) {
    window.clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  captionBusy.value += 1;
  try {
    const model = config.multimodal.model?.trim() || "未指定";
    log("info", "caption", "manual.start", { dir: job.outputDir, model, provider: config.multimodal.baseUrl });
    const result = await runJobCaption(config, job, (m) => log("info", "caption", "file.rerun", { message: m }));
    log("info", "caption", "manual.done", { dir: job.outputDir, model, described: result.described, failed: result.failed });
    return result.ok;
  } catch (err) {
    log("error", "caption", "manual.failed", { message: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    captionBusy.value -= 1;
    maybeAutoClose();
  }
}

/** 转到主工作站（冷启动 --parse 时主窗是隐藏的，这里按需显示并置前）。 */
async function openWorkbench(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("lu_show_workbench");
    log("info", "progress", "openWorkbench");
  } catch (err) {
    log("warn", "progress", "openWorkbench.failed", { message: err instanceof Error ? err.message : String(err) });
  }
}

async function closeWindow(): Promise<void> {
  // G·3：经 Rust 命令销毁本窗（每轮独立窗口，不复用）；不依赖 JS 关闭权限。
  if (!isTauri() || !myLabel) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("lu_close_progress", { label: myLabel });
  } catch {
    // 忽略
  }
}
</script>

<template>
  <main class="prog">
    <div class="prog-head">
      <span class="prog-title">直接解析</span>
      <button class="link" :disabled="refreshing || !hasActive()" @click="manualRefresh">
        {{ refreshing ? "刷新中…" : "刷新" }}
      </button>
    </div>

    <div v-if="taskId" class="prog-count">共 {{ files.length }} 个文件</div>
    <div v-if="errorMsg && files.length === 0" class="prog-error">{{ errorMsg }}</div>
    <div v-else-if="!taskId" class="prog-empty">等待文件…</div>
    <div v-if="staleHint" class="prog-empty">{{ staleHint }}</div>

    <div class="prog-list">
      <FileList
        :files="files"
        :task-id="taskId"
        :caption-runner="onFileCaption"
        @retry="onFileRetry"
        @edit-dir="onFileEditDir"
        @open="onFileOpen"
      />
    </div>

    <div class="prog-actions">
      <button v-if="hasActive()" class="danger" @click="cancelAll">全部取消</button>
      <button class="primary" @click="openWorkbench">转到工作站</button>
      <button v-if="allTerminal()" @click="openDir">打开目录</button>
      <button v-if="taskId" @click="closeWindow">关闭</button>
    </div>
  </main>
</template>

<style scoped>
.prog {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  padding: 12px 14px;
  gap: 8px;
  overflow: hidden;
  text-align: left;
  color: #0f0f0f;
}
.prog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.prog-title {
  font-size: 15px;
  font-weight: 600;
}
.prog-count {
  font-size: 12px;
  color: #666;
  flex-shrink: 0;
}
.prog-error {
  font-size: 12px;
  color: var(--lu-danger, #f04f75);
  flex-shrink: 0;
}
.prog-empty {
  font-size: 13px;
  color: #999;
  text-align: center;
  padding: 20px 0;
  flex-shrink: 0;
}
.prog-list {
  flex: 1;
  min-height: 80px;
  overflow-y: auto;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
}
.prog-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
button {
  border-radius: 8px;
  border: 1px solid #d4d4d4;
  padding: 0.4em 1em;
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
button.danger {
  background-color: var(--lu-danger, #f04f75);
  border-color: var(--lu-danger, #f04f75);
  color: #ffffff;
}
button.link {
  border: none;
  background: none;
  color: var(--lu-primary, #0e8afe);
  padding: 2px 6px;
  font-size: 12px;
}
@media (prefers-color-scheme: dark) {
  .prog {
    color: #f6f6f6;
  }
  .prog-count,
  .prog-empty {
    color: #aaa;
  }
  .prog-list {
    border-color: #3a3a3a;
  }
  button {
    background-color: #2c2c2c;
    border-color: #444;
    color: #f6f6f6;
  }
}
</style>

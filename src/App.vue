<script setup lang="ts">
// 阶段 4 轮 C（T4-04 + T4-08）：主工作站完整交互。
// 布局依据 UI 规格 §2；D-38（导入后手动开始 / 开始-停止双态）、D-39（任务 1:N）、D-40（事件推送）。
// 解析链路经 core/tasks（createTask/submitAll/cancel/retryFile）+ core/pipeline，UI 不直接调 client。
// 实时状态经 lu: 事件（T4-08）驱动；store 仅 Tauri 初始化，降级内存态。
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { TaskManager } from "./core/tasks";
import { SUPPORTED_INPUT_EXTS } from "./core/pipeline";
import { loadConfig, saveConfig } from "./core/config";
import { createConfigStore } from "./core/platform/store";
import { createSecretsAdapter } from "./core/platform/secrets";
import { createSqlAdapter } from "./core/platform/sql";
import { createFsAdapter } from "./core/platform/fs";
import { createStore } from "./core/store";
import { resolveCaptionEnabled } from "./core/caption";
import { runJobCaption } from "./core/caption/manual";
import { isTauri } from "./core/platform/env";
import { initLogger, log, setDebugEnabled, setMaxSizeMB, getLogDir } from "./core/platform/logger";
import { onCliCommand, onHistoryChanged, onLogLine, onTaskProgress, onTaskStatus } from "./core/platform/events";
import { openProgressWindow } from "./core/platform/window";
import { pushUserMessage, concludeUserMessage } from "./core/platform/user-feed";
import { toUserMessageOrGeneric, type UserAction } from "./core/platform/user-messages";
import FileList from "./ui/FileList.vue";
import NotificationPanel from "./ui/NotificationPanel.vue";
import SettingsPage from "./ui/settings/SettingsPage.vue";
import Icon from "./ui/components/Icon.vue";
import logoUrl from "./assets/logo.svg";
import type { Store, TaskRow, TaskFileRow } from "./core/store";
import type { Job } from "./core/types";

// D.10：manager 用 shallowRef 而非 ref——TaskManager 是含 config/jobs/queue 的复杂类实例，
// 若用 ref 会被 Vue 深度 reactivize，导致 config 变成 reactive Proxy，stripSecrets→structuredClone 抛
// "could not be cloned"（即「自动/手动」二次切换失败）。shallowRef 只包裹外层引用，内部保持纯对象。
const manager = shallowRef<TaskManager | null>(null);
const storeRef = ref<Store | null>(null);
/** 等待态：已导入未开始（D-38） */
const pending = ref<string[]>([]);
/** T5-08/D-64：>50 导入自动分批后，尚未创建的后续批次队列（前一批全部终态后自动创建下一批） */
const pendingBatches = ref<string[][]>([]);
/** T5-08/D-64：单批文件数上限（需求 §七 / D-26） */
const BATCH_SIZE = 50;
/** 当前任务的文件运行态（fileId → Job） */
const active = ref<Record<string, Job>>({});
const currentTaskId = ref<string | null>(null);
const busy = ref(false);
/** D.8：手动刷新 loading 态 */
const refreshing = ref(false);
/** D-54：自动/手动开始开关（默认手动；持久化到 config.tasks.autoStart） */
const autoStart = ref(false);
/** 图片解析开关（跟随当前输出入口的 captionEnabled，控制解析后是否自动生成图片描述） */
const captionOn = ref(false);
const notice = ref("");
/** 通知面板「去设置」动作携带的目标分组（打开设置页时跳转） */
const settingsGroup = ref<"mineru" | "caption" | "output" | "log" | undefined>(undefined);
const storeUnavailable = ref(false);
const historyTasks = ref<TaskRow[]>([]);
const historyFiles = ref<Record<string, TaskFileRow[]>>({});
const expanded = ref<Set<string>>(new Set());
const sidebarHidden = ref(false);
const placeholder = ref("");
/** T5-07/D-61：设置页开关（主工作站同窗页面切换） */
const showSettings = ref(false);
const searchQuery = ref("");
const elapsedByFile = ref<Record<string, number>>({});
let unEvents: Array<() => void> = [];
/** D.6：状态轮询兜底（事件未达时也能刷新，避免"卡等待/按钮卡死"） */
let pollTimer: number | null = null;
/** T5-F：右键多选时 shell 一次只转一个文件的 parse 事件；累积防抖后一次性开进度窗，合成单任务批量解析 */
const parseBuffer: string[] = [];
let parseFlushTimer: number | null = null;
/** 防止「图片描述未配置」提示在分批时重复刷屏（本轮会话内只提示一次） */
let captionNotified = false;

/** D-98：正在执行图片解析的输出目录（同一目录连点只跑一次） */
const captionInFlight = new Set<string>();

/**
 * D-94：多模态服务是否已配置（地址与密钥均非空）。
 * 未配置时不再把 captionEnabled 传给任务——否则每张图都会独立失败并各弹一条通知
 *（曾出现 13 张图 13 条「未配置 base_url」），与提示文案「已跳过」自相矛盾。
 */
function hasMultimodal(cfg: { multimodal: { baseUrl: string; apiKey: string } }): boolean {
  return Boolean(cfg.multimodal.baseUrl?.trim() && cfg.multimodal.apiKey?.trim());
}

/** 图片描述生效开关：用户已启用 且 服务已配置；未配置时提示一次并降级为跳过 */
function effectiveCaption(cfg: { multimodal: { baseUrl: string; apiKey: string } }, enabled: boolean): boolean {
  if (!enabled) return false;
  if (hasMultimodal(cfg)) return true;
  if (!captionNotified) {
    captionNotified = true;
    notify("caption.not-configured");
  }
  return false;
}
/** 轮 H：当前「全部开始」会话的通知 id——同一批次（含多批顺序处理）共用，过程累计、终态收口 */
let feedBatchId: string | null = null;
/** 轮 H：每个任务的历史「重试」尝试次数（用于通知展示 次数N） */
const retryCounts: Record<string, number> = {};

const TERMINAL = new Set(["done", "failed", "canceled", "interrupted"]);

onMounted(async () => {
  await initLogger();
  // 改名说明（合规）：项目曾用名 BetterMinerU，出于合规风险及名称/描述可能被误解的考虑，已更名为 LighterU（LU）。
  log("info", "app", "rename.notice", {
    formerName: "BetterMinerU",
    currentName: "LighterU",
    abbr: "LU",
    reason: "合规风险及名称/描述可能被误解，已更名",
  });

  // T4-07 冷启动意图：在加载配置/DB 之前先处理，确保主窗初始化失败时右键解析仍能拉起进度窗。
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cmd = await invoke<{ action: string; file_paths?: string[] | null } | null>("lu_get_launch_action");
      log("info", "app", "launchAction", { action: cmd?.action ?? "none", fileCount: cmd?.file_paths?.length ?? 0 });
      // 轮 I 启动自愈：非「直接解析」启动时兜底显示主窗并置前。
      if (!cmd || cmd.action !== "parse") {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const w = getCurrentWindow();
          await w.show();
          await w.unminimize();
          await w.setFocus();
          log("info", "app", "main.shown", { action: cmd?.action ?? "none" });
        } catch (e) {
          log("warn", "app", "main.showFailed", { message: e instanceof Error ? e.message : String(e) });
        }
      }
      if (cmd) handleCliCommand(cmd.action, cmd.file_paths ?? []);
    } catch {
      // 忽略
    }
  }

  try {
    const config = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
    // 轮 G 日志重构：把调试日志开关/容量上限应用到 logger（默认关闭，避免大文件）
    setDebugEnabled(config.logging.debugEnabled);
    setMaxSizeMB(config.logging.maxSizeMB);
    let store: Store | undefined;
    if (isTauri()) {
      try {
        const sql = await createSqlAdapter("sqlite:app.db");
        store = createStore(sql);
        await store.initSchema();
        const rec = await TaskManager.recover(store, config.tasks.staleTimeoutMs);
        if (rec.interrupted + rec.failed > 0) {
          notify("recover.done", { message: `${rec.interrupted} 个任务标记中断，${rec.failed} 个超时转失败` });
        }
      } catch (err) {
        store = undefined;
        storeUnavailable.value = true;
        notify("store.permission");
        log("error", "app", "store.initFailed", { message: err instanceof Error ? err.message : String(err) });
      }
    } else {
      storeUnavailable.value = true;
    }
    storeRef.value = store ?? null;
    const tm = new TaskManager(config, store);
    manager.value = tm;
    const cfg = tm.getConfig();
    autoStart.value = cfg.tasks.autoStart;
    const entryCfg = cfg.output.entry === "context-menu" ? cfg.output.rightClick : cfg.output.workbench;
    captionOn.value = resolveCaptionEnabled(entryCfg.captionEnabled, undefined);
    if (!cfg.mineru.token && cfg.mineru.apiMode !== "agent") notify("mineru.token.missing");
    // 冷启动右键解析容错：历史/DB 读取失败不应阻断后续 launch action 处理（否则 --parse 丢失）。
    try {
      await refreshHistory();
    } catch (err) {
      log("warn", "app", "history.initFailed", { message: err instanceof Error ? err.message : String(err) });
    }

    // T4-08：订阅事件驱动实时状态 / 进度 / 日志
    unEvents.push(
      onTaskStatus((p) => {
        const tm2 = manager.value;
        if (!tm2 || !p.fileId) return;
        const job = tm2.getJob(p.fileId);
        if (job) active.value = { ...active.value, [p.fileId]: { ...job } };
        if (p.taskId === currentTaskId.value) {
          const info = tm2.getTaskInfo(p.taskId);
          if (info && TERMINAL.has(info.status)) {
            busy.value = false;
            void refreshHistory();
            void maybeRunNextBatch();
          }
        }
      }),
      onTaskProgress((p) => {
        if (p.fileId) elapsedByFile.value = { ...elapsedByFile.value, [p.fileId]: p.elapsedMs };
      }),
      // onLogLine（pipeline 进度/失败）仅转发到调试日志黑盒；用户通知由核心模块经 user-feed 生成
      onLogLine((p) => {
        if (p.level === "info") log("debug", "pipeline", "progress", { message: p.message });
      }),
    );

    // T4-07/右键：第二实例 CLI 命令（推送）。首次启动意图已在 onMounted 开头处理，
    // 以免配置/DB 初始化失败时丢失 --parse。
    unEvents.push(onCliCommand((cmd) => handleCliCommand(cmd.action, cmd.file_paths ?? [])));

    // D-45：历史异步同步（100ms 去抖）
    let histTimer: number | null = null;
    unEvents.push(
      onHistoryChanged(() => {
        if (histTimer != null) window.clearTimeout(histTimer);
        histTimer = window.setTimeout(() => void refreshHistory(), 100);
      }),
    );
  } catch (err) {
    notify("generic.error", { message: err instanceof Error ? err.message : String(err) });
    if (process.env.NODE_ENV !== "production") {
      void import("./dev/diag").then(({ diag }) =>
        diag(`App.vue onMounted 失败: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
      );
    }
  }
  if (process.env.NODE_ENV !== "production" && location.search.includes("probe=1")) {
    void import("./dev/probe").then(({ runPluginProbes }) => runPluginProbes((line) => log("debug", "app", "probe", { line })));
  }
  if (process.env.NODE_ENV !== "production") {
    void import("./dev/diag").then(async ({ onDiagWriteFailure }) => {
      onDiagWriteFailure((err) => notify("generic.error", { message: `诊断日志写入失败：${err instanceof Error ? err.message : String(err)}` }));
    });
  }
});

onBeforeUnmount(() => {
  for (const off of unEvents) off();
  unEvents = [];
  if (pollTimer != null) window.clearInterval(pollTimer);
});

// 轮 G 日志重构：把内部 code 映射为用户通知并推入内存通知流（底部面板只展示用户需要知道/操作的）
/** 推送一条用户通知；opts.id 提供则按 id 原地更新（过程型消息累计过程、最后收口为结果）。 */
function notify(code: string, ctx?: Record<string, unknown>, opts?: { id?: string }): void {
  log('debug', 'app', 'notify', { code, id: opts?.id ?? null });
  pushUserMessage(toUserMessageOrGeneric(code, ctx), opts?.id ? { id: opts.id } : undefined);
}

// D.6：busy 期间轮询兜底同步 TaskManager 真实状态（补事件未达/丢失的情况）
watch(busy, (running) => {
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!running) return;
  pollTimer = window.setInterval(() => {
    const tm = manager.value;
    const id = currentTaskId.value;
    if (!tm || !id) return;
    const files = tm.taskFiles(id);
    if (files.length > 0) {
      const next = { ...active.value };
      for (const f of files) next[f.id] = { ...f };
      active.value = next;
    }
    const info = tm.getTaskInfo(id);
    if (info && TERMINAL.has(info.status)) {
      busy.value = false;
      void refreshHistory();
      void maybeRunNextBatch();
    }
  }, 800);
});

function baseName(p: string): string {
  return p.replace(/^.*[\\/]/, "");
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------- 导入（多选 + 文件夹）
const SUPPORTED_EXTS = new Set<string>(SUPPORTED_INPUT_EXTS as readonly string[]);
function isSupportedFile(p: string): boolean {
  const ext = p.toLowerCase().split(".").pop() ?? "";
  return SUPPORTED_EXTS.has(ext);
}

async function pickFiles(): Promise<void> {
  const selected = await open({
    multiple: true,
    filters: [
      { name: "支持的文档", extensions: [...SUPPORTED_INPUT_EXTS] },
      { name: "PDF", extensions: ["pdf"] },
      { name: "图片", extensions: ["png", "jpg", "jpeg", "jp2", "webp", "gif", "bmp"] },
      { name: "Office", extensions: ["doc", "docx", "ppt", "pptx", "xls", "xlsx"] },
    ],
  });
  if (!selected) return;
  const list = Array.isArray(selected) ? selected : [selected];
  addPdfs(list);
}

async function pickFolder(): Promise<void> {
  const dir = await open({ directory: true });
  if (!dir || typeof dir !== "string") return;
  log('debug', 'app', 'scanFolder', { dir });
  const found = await scanFolderPdfs(dir, 0);
  addPdfs(found);
}

function addPdfs(list: string[]): void {
  const accepted = list.filter(isSupportedFile);
  const rejected = list.length - accepted.length;
  const fresh = accepted.filter((p) => !pending.value.includes(p) && !Object.values(active.value).some((j) => j.inputPath === p));
  log('info', 'app', 'import.enter', { total: list.length, accepted: accepted.length, fresh: fresh.length, rejected });
  pending.value = [...pending.value, ...fresh];
  notice.value = rejected > 0
    ? `已忽略 ${rejected} 个不支持的文件（支持 PDF、图片、Doc/Docx/PPT/PPTx/Xls/Xlsx）`
    : fresh.length === 0 && accepted.length > 0 ? "所选文件已在列表中" : "";
  if (fresh.length > 0) {
    notify("batch.imported", { message: `已加入等待队列 ${fresh.length} 个文件` });
  }
  log('info', 'app', 'import.done', { added: fresh.length, pending: pending.value.length });
  maybeAutoStart();
}

/** 递归扫描文件夹内受支持的文档（深度受限；跳过拆分调试目录） */
async function scanFolderPdfs(dir: string, depth: number): Promise<string[]> {
  if (depth > 6) return [];
  const fs = createFsAdapter();
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readDir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = `${dir.replace(/[\\/]+$/, "")}/${e.name}`;
    if (e.isDir) {
      if (e.name === "_lusplit_debug") continue;
      out.push(...(await scanFolderPdfs(full, depth + 1)));
    } else if (isSupportedFile(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function removePending(target: string): void {
  pending.value = pending.value.filter((f) => f !== target);
}

async function maybeAutoStart(): Promise<void> {
  const tm = manager.value;
  if (tm && tm.getConfig().tasks.autoStart && pending.value.length > 0 && !busy.value) {
    await startAll();
  }
}

// ---------------------------------------------------------------- 全部开始 / 全部停止（D-51，覆盖 D-38 双态单按钮）
async function startAll(): Promise<void> {
  const tm = manager.value;
  if (!tm) {
    showPlaceholder("任务管理器未就绪，请稍候重试");
    return;
  }
  // #3：先判断是否真的可执行；没有任何可执行文件时不要再提示「全部开始」
  const nonTerminal = currentTaskId.value
    ? tm.taskFiles(currentTaskId.value).filter((f) => !TERMINAL.has(f.status))
    : [];
  if (pending.value.length === 0 && nonTerminal.length === 0) {
    log("info", "app", "startAll.nothing");
    notify("batch.nothing");
    showPlaceholder("无可执行的文件");
    return;
  }
  log("info", "app", "startAll.enter", { fileCount: pending.value.length, hasCurrentTask: Boolean(currentTaskId.value) });
  feedBatchId = `batch-${Date.now().toString(36)}`;
  notify("batch.progress", { message: `全部开始：待执行 ${pending.value.length} 个文件` }, { id: feedBatchId! });
  try {
    if (pending.value.length > 0) {
      const files = pending.value.slice();
      pending.value = [];
      // #6e：已有当前任务 → 追加到同一任务（任务=容器），直到用户点「创建新任务」
      if (currentTaskId.value) {
        busy.value = true;
        notice.value = "";
        await appendToCurrent(files);
        notify("batch.progress", { message: `已追加 ${files.length} 个文件到当前任务` }, { id: feedBatchId! });
        return;
      }
      // 无当前任务 → 新建任务（T5-08：>50 自动分批）
      const batches: string[][] = [];
      for (let i = 0; i < files.length; i += BATCH_SIZE) batches.push(files.slice(i, i + BATCH_SIZE));
      if (batches.length > 1) {
        pendingBatches.value = batches.slice(1);
        showPlaceholder(`共 ${files.length} 个文件，将分 ${batches.length} 批处理`);
        notify("batch.progress", { message: `超过 ${BATCH_SIZE} 个，分 ${batches.length} 批顺序处理` }, { id: feedBatchId! });
      } else {
        pendingBatches.value = [];
      }
      busy.value = true;
      notice.value = "";
      await runBatch(batches[0]);
      return;
    }
    // 无待导入，但当前任务有未终态文件 → 重新入队（取消/失败后继续）
    if (currentTaskId.value && nonTerminal.length > 0) {
      busy.value = true;
      await tm.submitAll(currentTaskId.value);
      notify("batch.progress", { message: `继续执行任务，${nonTerminal.length} 个未终态文件入队` }, { id: feedBatchId! });
      return;
    }
    showPlaceholder("无可执行的文件");
  } catch (err) {
    // D.9：不再静默吞掉——console.error + 日志 + toast，便于定位（如 store 写失败）
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lu] 全部开始失败：", err);
    log("error", "app", "startAll.failed", { message: msg });
    notify("generic.error", { message: `全部开始失败：${msg}` });
    showPlaceholder(`启动失败：${msg}`);
  }
}

/** #6e：把新导入的文件追加到当前任务并提交 */
async function appendToCurrent(files: string[]): Promise<void> {
  const tm = manager.value;
  const id = currentTaskId.value;
  if (!tm || !id) return;
  let cfg = tm.getConfig();
  try {
    const fresh = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
    tm.applyConfig(fresh);
    cfg = fresh;
  } catch {
    // 沿用旧配置
  }
  const activeEntry = cfg.output.entry === "context-menu" ? cfg.output.rightClick : cfg.output.workbench;
  const captionEnabled = effectiveCaption(cfg, resolveCaptionEnabled(activeEntry.captionEnabled, undefined));
  await tm.appendFiles(id, files, {
    captionEnabled,
    processingLocation: cfg.output.entry === "context-menu" ? "inplace" : "workbench",
    format: activeEntry.format,
    outputs: activeEntry.outputs,
    captionMode: activeEntry.captionMode,
    sameNameHandling: cfg.output.sameNameHandling,
    destDir: activeEntry.defaultDir,
    autoOpen: activeEntry.autoOpen,
  });
  const next = { ...active.value };
  for (const f of tm.taskFiles(id)) next[f.id] = { ...f };
  active.value = next;
  await tm.submitAll(id, Math.min(files.length, 50));
  // 追加后立即刷新历史（历史即进度的另一种视图，保持同步，不依赖事件到达时序）
  await refreshHistory();
}

/** T5-08：创建并入队单批（≤BATCH_SIZE） */
async function runBatch(files: string[]): Promise<void> {
  const tm = manager.value;
  if (!tm || files.length === 0) return;
  // T5-F：热加载最新配置（设置页保存后需刷新运行中的 TaskManager，否则用挂载时旧配置）
  let cfg = tm.getConfig();
  try {
    const fresh = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
    tm.applyConfig(fresh);
    cfg = fresh;
  } catch {
    // 重载失败沿用旧 cfg
  }
  const activeEntry = cfg.output.entry === "context-menu" ? cfg.output.rightClick : cfg.output.workbench;
  // D-94：未配置多模态时降级为跳过（提示一次），避免逐图报错刷屏
  const captionEnabled = effectiveCaption(cfg, resolveCaptionEnabled(activeEntry.captionEnabled, undefined));
  const wb = cfg.output.workbench;
  const taskId = await tm.createTask(files, {
    captionEnabled,
    processingLocation: cfg.output.entry === "context-menu" ? "inplace" : "workbench",
    format: wb.format,
    outputs: wb.outputs,
    captionMode: wb.captionMode,
    sameNameHandling: cfg.output.sameNameHandling,
    destDir: wb.defaultDir,
    autoOpen: wb.autoOpen,
  });
  currentTaskId.value = taskId;
  const next = { ...active.value };
  for (const f of tm.taskFiles(taskId)) next[f.id] = { ...f };
  active.value = next;
  notify("batch.created", { task: taskId.slice(-4), count: files.length }, { id: feedBatchId! });
  log("info", "app", "startAll.taskCreated", { taskId, count: files.length });
  // T5-F：一次提交本批全部文件（并发，上限 50）
  await tm.submitAll(taskId, Math.min(files.length, 50));
  log("debug", "app", "startAll.submitted", { taskId });
  // 新建任务后立即刷新历史（历史即进度的另一种视图，保持同步）
  await refreshHistory();
}

/** T5-08：当前批全部终态后，自动创建并入队下一批 */
async function maybeRunNextBatch(): Promise<void> {
  if (pendingBatches.value.length === 0) return;
  const tm = manager.value;
  const id = currentTaskId.value;
  if (tm && id) {
    const info = tm.getTaskInfo(id);
    if (info && !TERMINAL.has(info.status)) return; // 当前批仍未全部终态，等待
  }
  const next = pendingBatches.value[0];
  pendingBatches.value = pendingBatches.value.slice(1);
  busy.value = true;
  notify("batch.progress", { message: `继续下一批（剩余 ${pendingBatches.value.length} 批）` }, { id: feedBatchId! });
  log("info", "app", "batch.next", { remaining: pendingBatches.value.length });
  await runBatch(next);
}

function stopAll(): void {
  const tm = manager.value;
  const id = currentTaskId.value;
  if (tm && id) {
    const nonTerminal = tm.taskFiles(id).filter((f) => !TERMINAL.has(f.status));
    if (nonTerminal.length > 0) {
      tm.cancel(id);
      tm.clearQueue();
      const next = { ...active.value };
      for (const f of tm.taskFiles(id)) next[f.id] = { ...f };
      active.value = next;
      busy.value = false;
      if (feedBatchId) concludeUserMessage(feedBatchId, toUserMessageOrGeneric("batch.stopped"));
      feedBatchId = null;
      return;
    }
  }
  showPlaceholder("无运行中任务");
}

/** D.8：手动刷新——立即同步当前任务权威态（不等轮询/事件）；按钮 loading 1s + toast「已刷新」 */
function manualRefresh(): void {
  const tm = manager.value;
  const id = currentTaskId.value;
  if (!tm || !id) return;
  refreshing.value = true;
  const files = tm.refreshStatus(id);
  const next = { ...active.value };
  for (const f of files) next[f.id] = { ...f };
  active.value = next;
  void refreshHistory();
  log("debug", "app", "manualRefresh");
  window.setTimeout(() => {
    refreshing.value = false;
    showPlaceholder("已刷新");
  }, 1000);
}

async function retryFile(taskId: string, fileId: string): Promise<void> {
  const tm = manager.value;
  if (!tm) return;
  try {
    await tm.retryFile(taskId, fileId);
    busy.value = true;
    active.value = { ...active.value, [fileId]: { ...(tm.getJob(fileId) as Job) } };
  } catch (err) {
    notify("retry.failed", { message: `重试失败：${err instanceof Error ? err.message : String(err)}` });
  }
}

/** D-41：历史任务「重试」= 重试该任务下所有失败文件（轮 H：过程→结果，同一 id 收口；展示文件清单 + 次数） */
async function retryHistoryTask(taskId: string): Promise<void> {
  const tm = manager.value;
  if (!tm) return;
  const rid = `retry-${taskId}`;
  // 收集本次要重新提交的失败文件清单（过程型通知展示具体文件）
  const failedNames = tm
    .taskFiles(taskId)
    .filter((f) => f.status === "failed")
    .map((f) => baseName(f.inputPath));
  const shown = failedNames.slice(0, 12);
  const list = shown.join("、") + (failedNames.length > shown.length ? ` 等 ${failedNames.length} 个` : "");
  retryCounts[taskId] = (retryCounts[taskId] ?? 0) + 1;
  const attempt = retryCounts[taskId];
  pushUserMessage(
    toUserMessageOrGeneric("retry.progress", {
      message: `重新提交失败的文件（${list || "无"}），次数${attempt}`,
    }),
    { id: rid },
  );
  try {
    const { retried, skipped } = await tm.retryTask(taskId);
    concludeUserMessage(rid, toUserMessageOrGeneric("retry.success", { message: `${retried} 个文件重新提交${skipped > 0 ? `，${skipped} 个达到上限跳过` : ""}` }));
    if (retried > 0) busy.value = true;
    await refreshHistory();
  } catch (err) {
    concludeUserMessage(rid, toUserMessageOrGeneric("retry.failed", { message: `重试失败：${err instanceof Error ? err.message : String(err)}` }));
  }
}

/** FileList 事件转发 */
function onFileRetry(fileId: string): void {
  if (currentTaskId.value) void retryFile(currentTaskId.value, fileId);
}

/** T4-07/D.9：汇聚 CLI / 第二实例命令（parse 支持多文件 → 开进度窗，非主工作站） */
function handleCliCommand(action: string, filePaths: string[]): void {
  log("info", "app", "cliCommand.enter", { action, fileCount: filePaths.length });
  switch (action) {
    case "parse":
      if (filePaths.length > 0) {
        log("info", "app", "cliCommand.parse", { fileCount: filePaths.length });
        // T5-F：多选 → shell 逐文件转来多条 parse 事件；累积去重 + 防抖 250ms 后一次性开进度窗（合成单任务）
        for (const p of filePaths) if (!parseBuffer.includes(p)) parseBuffer.push(p);
        if (parseFlushTimer != null) window.clearTimeout(parseFlushTimer);
        parseFlushTimer = window.setTimeout(() => {
          parseFlushTimer = null;
          const batch = parseBuffer.splice(0, parseBuffer.length);
          if (batch.length === 0) return;
          log("info", "app", "cliCommand.parseFlush", { fileCount: batch.length });
          void openProgressWindow(batch).then(async (ok) => {
            log(ok ? "debug" : "warn", "app", "cliCommand.openProgress", { ok });
            if (ok) return;
            log("warn", "app", "cliCommand.fallbackWorkbench", { reason: "openProgressWindow returned false" });
            notify("window.open-failed");
            showPlaceholder("无法打开进度窗，已在工作站打开");
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
          });
        }, 250);
      }
      break;
    case "open-workbench":
      // 进度窗「转到工作站」：确保回到工作站视图（若正停留在设置页）
      showSettings.value = false;
      break;
    case "open-settings":
      showPlaceholder("设置页将在阶段 5 实现");
      break;
    default:
      break;
  }
}

/** D-54：自动/手动切换——手动（默认）导入后待「全部开始」；自动导入即开始。持久化到 config.tasks.autoStart。 */
async function toggleAutoStart(): Promise<void> {
  const tm = manager.value;
  const next = !autoStart.value;
  autoStart.value = next;
  if (!tm) return;
  tm.getConfig().tasks.autoStart = next;
  notify("generic.info", { message: next ? "已切换为自动模式（导入即开始）" : "已切换为手动模式（导入后需点全部开始）" });
  try {
    await saveConfig({ store: createConfigStore(), secrets: createSecretsAdapter() }, tm.getConfig());
  } catch (err) {
    notify("config.save.failed", { message: `保存自动/手动偏好失败：${err instanceof Error ? err.message : String(err)}` });
  }
}

/** 图片解析开关：切换当前输出入口的 captionEnabled 并持久化 */
async function toggleCaption(): Promise<void> {
  const tm = manager.value;
  const next = !captionOn.value;
  captionOn.value = next;
  if (!tm) return;
  const cfg = tm.getConfig();
  const entry = cfg.output.entry === "context-menu" ? cfg.output.rightClick : cfg.output.workbench;
  entry.captionEnabled = next;
  notify("generic.info", { message: next ? "已开启图片解析（解析后自动生成图片描述）" : "已关闭图片解析" });
  try {
    await saveConfig({ store: createConfigStore(), secrets: createSecretsAdapter() }, cfg);
  } catch {
    // 保存失败不阻断开关生效
  }
}

/** 行内停止：取消当前任务（V0.3 按任务粒度取消） */
function onFileStop(): void {
  const tm = manager.value;
  const id = currentTaskId.value;
  if (tm && id) tm.cancel(id);
}

/** 行内刷新：立即同步该任务权威状态 */
function onFileRefresh(): void {
  const tm = manager.value;
  const id = currentTaskId.value;
  if (!tm || !id) return;
  const files = tm.refreshStatus(id);
  const next = { ...active.value };
  for (const f of files) next[f.id] = { ...f };
  active.value = next;
  showPlaceholder("已刷新");
}

/** 行内「图片解析」：对该文件已产出的输出目录单独重跑图片描述（使用当前选中提示词方案） */
async function onFileCaption(job: Job): Promise<boolean> {
  const tm = manager.value;
  if (!tm) return false;
  if (!job.outputDir) {
    notify("generic.info", { message: "该文件尚无输出目录，无法生成图片描述" });
    return false;
  }
  // D-98：同一输出目录单飞——连点「图片解析」只执行一次，后续点击仅提示
  const dirKey = job.outputDir;
  if (captionInFlight.has(dirKey)) {
    notify("generic.info", { message: "该目录的图片解析正在进行中，请稍候" });
    return false;
  }
  captionInFlight.add(dirKey);
  try {
    // D-96：设置页可能刚改过服务商/密钥，必须重新加载配置——
    // 旧实现直接用 tm.getConfig() 的启动快照，导致「切到 DeepSeek 后仍请求 moonshot 并 401」。
    let cfg = tm.getConfig();
    try {
      const fresh = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
      tm.applyConfig(fresh);
      cfg = fresh;
    } catch {
      // 重载失败沿用旧配置
    }
    // D-94：手动重跑同样需要已配置；否则会为每张图各弹一条失败通知
    if (!hasMultimodal(cfg)) {
      notify("caption.not-configured");
      return false;
    }
    const model = cfg.multimodal.model?.trim() || "未指定";
    notify("caption.started", { model, dir: dirKey });
    log("info", "caption", "manual.start", { dir: dirKey, model, provider: cfg.multimodal.baseUrl });
    const result = await runJobCaption(cfg, job, (m) => log("info", "caption", "file.rerun", { message: m }));
    if (result.skipped) {
      notify("generic.info", { message: `图片解析已跳过：${result.skipped}` });
    } else {
      notify("caption.finished", { model, described: result.described, failed: result.failed });
    }
    log("info", "caption", "manual.done", { dir: dirKey, model, described: result.described, failed: result.failed });
    return result.ok;
  } catch (err) {
    notify("generic.error", { message: `图片解析失败：${err instanceof Error ? err.message : String(err)}` });
    return false;
  } finally {
    captionInFlight.delete(dirKey);
  }
}

/** D-43：FileList「打开」——始终打开输出所在文件夹（不再直接打开 full.md 文件） */
async function onFileOpen(job: Job): Promise<void> {
  const dir = job.outputDir ?? (job.markdownPath ? job.markdownPath.replace(/[\\/][^\\/]+$/, "") : null);
  if (!dir) {
    notify("generic.info", { message: "该文件暂无输出" });
    return;
  }
  await openOutput(dir);
}

/** D-42：FileList 输出目录行内修改——设为 destDirOverride，下次执行生效 */
async function onFileEditDir(fileId: string): Promise<void> {
  const tm = manager.value;
  if (!tm) return;
  const job = tm.getJob(fileId);
  if (!job) return;
  const dir = await open({ directory: true, defaultPath: job.destDirOverride ?? job.outputDir ?? undefined });
  if (!dir || typeof dir !== "string") return;
  job.destDirOverride = dir;
  active.value = { ...active.value, [fileId]: { ...job } };
  notice.value = busy.value
    ? `输出目录已设为 ${dir}（当前任务用原目录，下次执行生效）`
    : `输出目录已设为 ${dir}（下次执行生效）`;
}

// ---------------------------------------------------------------- 主工作站交互
function toggleSidebar(): void {
  sidebarHidden.value = !sidebarHidden.value;
}

function showPlaceholder(msg: string): void {
  placeholder.value = msg;
  window.setTimeout(() => {
    if (placeholder.value === msg) placeholder.value = "";
  }, 2500);
}

function newTask(): void {
  // 运行中也可新建：先停止当前任务再清空（避免按钮卡死后无法恢复）
  if (busy.value) {
    stopAll();
    notify("generic.info", { message: "已停止当前任务并新建" });
  }
  pending.value = [];
  active.value = {};
  currentTaskId.value = null;
  elapsedByFile.value = {};
  busy.value = false;
  notify("generic.info", { message: "已创建新任务，导入文件后点「开始」" });
}

async function refreshHistory(): Promise<void> {
  const s = storeRef.value;
  if (!s) return;
  try {
    // 轮 J：历史=进度的另一种视图，默认展示最近 100 条任务；文件清单仍按需（展开时才 loadFiles）。
    historyTasks.value = await s.getHistory({ limit: 100 });
  } catch (err) {
    // 不再静默：查询异常会导致历史「只显示一条/不更新」，必须留痕
    log("warn", "app", "history.refreshFailed", { message: err instanceof Error ? err.message : String(err) });
  }
}

// 缓存搜索结果：模板中会用到两次（判空 + v-for），避免每次渲染重复 filter
const filteredHistory = computed<TaskRow[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return historyTasks.value;
  return historyTasks.value.filter((t) => t.fileName.toLowerCase().includes(q) || t.inputPath.toLowerCase().includes(q));
});

async function toggleTask(id: string): Promise<void> {
  const next = new Set(expanded.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
    const s = storeRef.value;
    if (s && !historyFiles.value[id]) {
      try {
        historyFiles.value = { ...historyFiles.value, [id]: await s.loadFiles(id) };
      } catch {
        // 忽略
      }
    }
  }
  expanded.value = next;
}

function taskName(t: TaskRow): string {
  return t.fileName || `任务 ${t.id.slice(-4)}`;
}

/** #6d：任务名内联重命名 */
const editingTaskId = ref<string | null>(null);
const editingName = ref("");

function startRename(t: TaskRow): void {
  editingTaskId.value = t.id;
  editingName.value = taskName(t);
}

async function commitRename(): Promise<void> {
  const id = editingTaskId.value;
  const name = editingName.value.trim();
  editingTaskId.value = null;
  if (!id || !name) return;
  const s = storeRef.value;
  if (!s) return;
  try {
    await s.updateTask(id, { fileName: name });
    await refreshHistory();
    log("info", "app", "renameTask", { id, name });
  } catch (err) {
    notify("generic.error", { message: `重命名失败：${err instanceof Error ? err.message : String(err)}` });
  }
}

/** #6c：点击历史文件 → 把该任务全部文件载入进度面板继续操作（任务=容器） */
async function resumeTask(t: TaskRow): Promise<void> {
  const tm = manager.value;
  if (!tm) return;
  const ok = await tm.loadTask(t.id);
  if (!ok) {
    notify("generic.error", { message: "无法载入该历史任务" });
    return;
  }
  currentTaskId.value = t.id;
  const next: Record<string, Job> = {};
  for (const f of tm.taskFiles(t.id)) next[f.id] = { ...f };
  active.value = next;
  busy.value = tm.taskFiles(t.id).some((f) => !TERMINAL.has(f.status));
  notify("generic.info", { message: `已载入任务「${taskName(t)}」到进度面板，可继续操作` });
  log("info", "app", "resumeTask", { taskId: t.id, files: Object.keys(next).length });
}

/** #5：全部重试——重试当前任务下所有失败文件 */
async function retryAllActive(): Promise<void> {
  const tm = manager.value;
  const id = currentTaskId.value;
  if (!tm || !id) {
    notify("retry.nothing");
    return;
  }
  const failed = tm.taskFiles(id).filter((f) => f.status === "failed");
  if (failed.length === 0) {
    notify("retry.nothing");
    return;
  }
  await retryHistoryTask(id);
  busy.value = true;
}

function fileLoc(t: TaskRow, f: TaskFileRow): string {
  return f.outputPath ?? t.outputDir ?? "—";
}

async function openOutput(dir: string | null | undefined): Promise<void> {
  if (!dir) {
    notify("generic.info", { message: "该任务暂无输出目录" });
    return;
  }
  try {
    await openPath(dir);
  } catch (err) {
    notify("open.failed", { message: err instanceof Error ? err.message : String(err) });
  }
}

async function deleteTask(id: string): Promise<void> {
  const s = storeRef.value;
  if (!s) return;
  try {
    await s.deleteBatch(id);
    const nextExp = new Set(expanded.value);
    nextExp.delete(id);
    expanded.value = nextExp;
    const nf = { ...historyFiles.value };
    delete nf[id];
    historyFiles.value = nf;
    await refreshHistory();
    notify("history.deleted");
  } catch (err) {
    notify("history.delete.failed", { message: `删除失败：${err instanceof Error ? err.message : String(err)}` });
  }
}

// 轮 H #8：删除全部历史——两次点击确认（首次变「？」，再次点击才删；否则 2 秒后或点击其他位置自动还原）。
const deleteAllArmed = ref(false);
let deleteAllTimer: number | null = null;

function onDeleteAllOutside(e: Event): void {
  const btn = document.getElementById("del-all-btn");
  if (btn && btn.contains(e.target as Node)) return; // 点自身由 armDeleteAll 处理
  disarmDeleteAll();
}

function disarmDeleteAll(): void {
  deleteAllArmed.value = false;
  if (deleteAllTimer != null) {
    clearTimeout(deleteAllTimer);
    deleteAllTimer = null;
  }
  document.removeEventListener("click", onDeleteAllOutside, true);
}

function armDeleteAll(): void {
  if (deleteAllArmed.value) {
    void doDeleteAllHistory();
    return;
  }
  deleteAllArmed.value = true;
  document.addEventListener("click", onDeleteAllOutside, true);
  deleteAllTimer = window.setTimeout(() => {
    deleteAllArmed.value = false;
    deleteAllTimer = null;
    document.removeEventListener("click", onDeleteAllOutside, true);
  }, 2000);
}

async function doDeleteAllHistory(): Promise<void> {
  const s = storeRef.value;
  log('info', 'app', 'deleteAllHistory.start');
  disarmDeleteAll();
  if (!s) {
    log('warn', 'app', 'deleteAllHistory.noStore');
    return;
  }
  try {
    await s.deleteAllHistory();
    expanded.value = new Set();
    historyFiles.value = {};
    await refreshHistory();
    notify("history.deleted");
    log('info', 'app', 'deleteAllHistory.done');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify("history.delete.failed", { message: `删除失败：${msg}` });
    log('error', 'app', 'deleteAllHistory.failed', { message: msg });
  }
}

// 通知面板「去设置」动作：打开设置页并跳转到目标分组
function onNavigate(group: string): void {
  settingsGroup.value = group as typeof settingsGroup.value;
  showSettings.value = true;
}

// 通知面板除 navigate/open-log 外的动作（open-url / retry）
async function onFeedAction(a: UserAction): Promise<void> {
  if (a.kind === "open-url" && a.target) {
    try {
      // 仅允许 http/https；openPath 是文件路径 API，不能用于网址（原实现 bug）
      if (!/^https?:\/\//i.test(a.target)) throw new Error("仅允许 http/https 链接");
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(a.target);
    } catch {
      // 忽略
    }
  } else if (a.kind === "retry" && currentTaskId.value) {
    await retryHistoryTask(currentTaskId.value);
  }
}

// 调试日志（黑盒）入口：不预览，直接打开日志目录（复杂日志无法在应用内预览，跳转即打开文件夹）
async function openLogDir(): Promise<void> {
  const dir = getLogDir();
  if (!dir) {
    notify("open.failed", { message: "无法定位调试日志目录" });
    return;
  }
  try {
    await openPath(dir);
  } catch (err) {
    notify("open.failed", { message: err instanceof Error ? err.message : String(err) });
  }
}

// 缓存排序结果：模板中多处使用，避免每次渲染都 Object.values + sort
const activeList = computed<Job[]>(() => Object.values(active.value).sort((a, b) => a.createdAt - b.createdAt));
/** D.8：是否存在未终态文件（手动刷新按钮启用条件） */
const hasActive = computed<boolean>(() => activeList.value.some((j) => !TERMINAL.has(j.status)));
</script>

<template>
  <SettingsPage v-if="showSettings" :initial-group="settingsGroup" @close="showSettings = false" />
  <main v-else class="wb">
    <header class="topbar">
      <div class="tb-left">
        <button class="brand" title="返回主页面" @click="newTask">
          <img class="brand-logo" :src="logoUrl" alt="LighterU" />
          <span class="brand-name">LighterU</span>
        </button>
        <button class="icon-btn" :title="sidebarHidden ? '显示侧栏' : '隐藏侧栏'" @click="toggleSidebar">
          <Icon :name="sidebarHidden ? 'chevron-right' : 'chevron-left'" :size="18" />
        </button>
      </div>
      <div class="tb-right">
        <button class="icon-btn" title="设置" @click="showSettings = true"><Icon name="settings" :size="18" /></button>
      </div>
    </header>

    <div class="wb-body">
      <aside v-if="!sidebarHidden" class="sidebar">
        <div class="side-head">
          <button class="new-task" @click="newTask">＋ 创建新任务</button>
          <button id="del-all-btn" class="del-all" :class="{ armed: deleteAllArmed }" :title="deleteAllArmed ? '再次点击确认删除全部历史' : '删除全部历史（需二次确认）'" @click="armDeleteAll">
            <Icon name="trash" :size="13" />{{ deleteAllArmed ? "确认删除？" : "删除全部" }}
          </button>
        </div>
        <div class="history">
          <p v-if="storeUnavailable" class="hist-empty">历史记录不可用（仅 Tauri 桌面端持久化）</p>
          <p v-else-if="filteredHistory.length === 0" class="hist-empty">{{ searchQuery ? "无匹配历史" : "暂无历史记录" }}</p>
          <div v-for="t in filteredHistory" :key="t.id" class="hist-task">
            <div class="hist-task-row" @click="toggleTask(t.id)">
              <span class="twisty">{{ expanded.has(t.id) ? "▾" : "▸" }}</span>
              <input
                v-if="editingTaskId === t.id"
                v-model="editingName"
                class="t-name-edit"
                @click.stop
                @keyup.enter="commitRename"
                @keyup.esc="editingTaskId = null"
                @blur="commitRename"
              />
              <span v-else class="t-name" :title="t.inputPath + '（点击重命名）'" @click.stop="startRename(t)">{{ taskName(t) }}</span>
              <span class="t-date">{{ fmtDate(t.createdAt) }}</span>
              <span class="t-ops" @click.stop>
                <button class="link danger" @click="deleteTask(t.id)">删除</button>
              </span>
            </div>
            <div v-if="expanded.has(t.id)" class="hist-files">
              <div
                v-for="(f, i) in (historyFiles[t.id] ?? [])"
                :key="i"
                class="hist-file"
                title="点击载入到进度面板继续操作"
                @click="resumeTask(t)"
              >
                <span class="f-idx">{{ i + 1 }}.</span>
                <span class="f-name" :title="f.name">{{ f.name }}</span>
                <span class="f-loc" :title="fileLoc(t, f)">{{ fileLoc(t, f) }}</span>
                <span class="f-ops">
                  <button class="link" @click.stop="openOutput(t.outputDir ?? f.outputPath)">打开</button>
                </span>
              </div>
              <p v-if="(historyFiles[t.id] ?? []).length === 0" class="hist-file-empty">（无文件记录）</p>
            </div>
          </div>
        </div>
        <input v-model="searchQuery" class="search" placeholder="搜索历史…" />
      </aside>

      <section class="main">
        <!-- 进度控制行：导入胶囊（两半）+ 全部开始/重试/停止胶囊（三半）+ 模式/图片解析/刷新 -->
        <div class="control-row">
          <div class="ctl-left">
            <div class="capsule two">
              <button @click="pickFiles">导入文件</button>
              <button @click="pickFolder">导入文件夹</button>
            </div>
            <div class="capsule three">
              <button class="primary" @click="startAll"><Icon name="play" :size="15" />全部开始</button>
              <button class="retry" @click="retryAllActive"><Icon name="repeat" :size="15" />全部重试</button>
              <button class="danger" @click="stopAll"><Icon name="pause" :size="15" />全部停止</button>
            </div>
          </div>
          <div class="ctl-right">
            <button
              class="mode-btn"
              :class="{ on: autoStart }"
              :title="autoStart ? '自动模式：导入即开始' : '手动模式：导入后需点全部开始'"
              @click="toggleAutoStart"
            >
              <span class="mode-dot" />{{ autoStart ? "自动" : "手动" }}
            </button>
            <button class="mode-btn" :class="{ on: captionOn }" title="图片解析：解析后自动生成图片描述" @click="toggleCaption">
              图片解析
            </button>
            <button class="icon-btn" :disabled="refreshing || !hasActive" title="手动刷新" @click="manualRefresh">
              <Icon name="rotate-ccw" :size="16" />
            </button>
          </div>
        </div>
        <div v-if="placeholder || notice" class="status-line">{{ placeholder || notice }}</div>

        <!-- 进度显示面板 -->
        <div class="progress-panel">
          <div class="panel-head">
            <span class="col-name">文件名</span>
            <span class="col-status">状态</span>
            <span class="col-out">输出位置（点击可更改）</span>
            <span class="col-ops">操作</span>
          </div>
          <div v-if="pending.length > 0" class="pending">
            <div v-for="(file, i) in pending" :key="file" class="prow">
              <span class="p-idx">{{ i + 1 }}.</span>
              <span class="p-name" :title="file">{{ baseName(file) }}</span>
              <span class="p-status wait">未开始</span>
              <span class="p-out muted">等待导入</span>
              <span class="p-ops"><button class="link" @click="removePending(file)">移除</button></span>
            </div>
          </div>
          <div class="progress">
            <p v-if="activeList.length === 0 && pending.length === 0" class="empty">导入 PDF 或文件夹后点「全部开始」</p>
            <FileList
              :files="activeList"
              :task-id="currentTaskId"
              @retry="onFileRetry"
              @start="onFileRetry"
              @stop="onFileStop"
              @refresh="onFileRefresh"
              :caption-runner="onFileCaption"
              @edit-dir="onFileEditDir"
              @open="onFileOpen"
            />
          </div>
        </div>

        <!-- 通知面板：与进度面板同处右侧 -->
        <NotificationPanel @open-debug="openLogDir" @navigate="onNavigate" @action="onFeedAction" />
      </section>
    </div>
  </main>
</template>

<style scoped>
.wb {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  text-align: left;
  color: #0f0f0f;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 14px;
  min-height: 48px;
  box-sizing: border-box;
  border-bottom: 1px solid #e5e5e5;
  background: #ffffff;
  flex-shrink: 0;
}
.tb-left,
.tb-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 侧栏伸缩按钮落在历史栏右边缘（与下方侧栏同宽） */
/* 顶栏左内边距 14 + 274 = 288，与下方历史栏右边缘对齐 */
.tb-left {
  width: 274px;
  flex-shrink: 0;
  justify-content: space-between;
}
.tb-icon {
  border: none;
  background: none;
  font-size: 18px;
  padding: 4px 6px;
  cursor: pointer;
}
.tb-brand {
  font-size: 13px;
  font-weight: 600;
  color: #333;
  cursor: pointer;
}
.tb-btn {
  border-radius: 8px;
  border: 1px solid #d4d4d4;
  padding: 0.35em 0.8em;
  font-size: 13px;
  cursor: pointer;
  background: #ffffff;
  color: #0f0f0f;
}
.tb-btn.active {
  background: var(--lu-primary, #0e8afe);
  border-color: var(--lu-primary, #0e8afe);
  color: #ffffff;
}
.wb-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.sidebar {
  width: 288px;
  flex-shrink: 0;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  /* 历史记录：淡灰背景 */
  background: #f3f4f6;
  min-height: 0;
}
.new-task {
  margin: 10px;
  border-radius: 8px;
  border: 1px solid var(--lu-primary, #0e8afe);
  background: var(--lu-primary, #0e8afe);
  color: #fff;
  padding: 0.5em 1em;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.del-all {
  margin: 0 10px 10px;
  border-radius: 8px;
  border: 1px solid #d4d4d4;
  background: #fff;
  color: #888;
  padding: 0.4em 1em;
  font-size: 12px;
  cursor: pointer;
}
.del-all.armed {
  border-color: var(--lu-danger, #f04f75);
  background: var(--lu-danger, #f04f75);
  color: #fff;
  font-weight: 600;
}
@media (prefers-color-scheme: dark) {
  .del-all { background: #2c2c2c; border-color: #444; color: #aaa; }
  .del-all.armed { background: var(--lu-danger, #f04f75); border-color: var(--lu-danger, #f04f75); color: #fff; }
}
.history {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
  min-height: 0;
}
.hist-empty {
  font-size: 12px;
  color: #999;
  text-align: center;
  padding: 16px 8px;
  margin: 0;
}
.hist-task {
  border-bottom: 1px solid #f0f0f0;
}
.hist-task-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 6px;
  font-size: 13px;
  cursor: pointer;
}
.hist-task-row:hover {
  background: #f0f4fb;
}
.twisty {
  color: #888;
  flex-shrink: 0;
}
.t-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.t-name-edit {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid var(--lu-primary, #0e8afe);
  border-radius: 6px;
  background: #fff;
  color: #0f0f0f;
}
.t-date {
  font-size: 11px;
  color: #999;
  flex-shrink: 0;
}
.hist-files {
  padding: 2px 6px 8px 20px;
}
.hist-file {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 3px 0;
  cursor: pointer;
  border-radius: 6px;
}
.hist-file:hover {
  background: rgba(14, 138, 254, 0.08);
}
.f-idx {
  color: #999;
  flex-shrink: 0;
}
.f-name {
  flex-shrink: 0;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-loc {
  flex: 1;
  min-width: 0;
  color: #777;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-ops {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.hist-file-empty {
  font-size: 11px;
  color: #aaa;
  margin: 2px 0;
}
.search {
  margin: 8px 10px 10px;
  padding: 0.4em 0.7em;
  font-size: 12px;
  border: 1px solid #d4d4d4;
  border-radius: 8px;
  background: #ffffff;
  color: #0f0f0f;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 16px 14px;
  overflow: hidden;
  /* 右侧区域底层：淡绿（进度/通知面板本身仍为白色，浮在其上） */
  background: var(--lu-success-bg, #e6fcf8);
}
/* 顶栏品牌 */
.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: none;
  padding: 2px 4px;
  cursor: pointer;
}
.brand-logo {
  width: 26px;
  height: 30px;
  object-fit: contain;
  display: block;
}
.brand-name {
  font-size: 15px;
  font-weight: 800;
  color: var(--lu-primary, #0e8afe);
  letter-spacing: 0.2px;
}
.icon-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e5e7eb;
  border-radius: 9px;
  background: #fff;
  color: #4b5563;
  cursor: pointer;
  padding: 0;
}
.icon-btn:hover {
  border-color: var(--lu-primary, #0e8afe);
  color: var(--lu-primary, #0e8afe);
  background: #f2f8ff;
}
.icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 侧栏顶部 */
.side-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 10px 6px;
}
.side-head .new-task {
  margin: 0;
}
.side-head .del-all {
  margin: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
/* 进度控制行 */
.control-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.ctl-left,
.ctl-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.capsule {
  display: inline-flex;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  overflow: hidden;
  background: #fff;
}
.capsule button {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0.42em 0.85em;
  font-size: 13px;
  font-weight: 500;
  color: #374151;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}
.capsule button + button {
  border-left: 1px solid #e5e7eb;
}
.capsule button:hover {
  background: #f3f8ff;
  color: var(--lu-primary, #0e8afe);
}
.capsule button.primary {
  background: var(--lu-primary, #0e8afe);
  border-color: transparent;
  color: #fff;
}
.capsule button.primary:hover {
  filter: brightness(0.95);
  background: var(--lu-primary, #0e8afe);
  color: #fff;
}
/* 全部停止：红底白字 */
.capsule button.danger {
  background: var(--lu-danger, #f04f75);
  color: #fff;
}
.capsule button.danger:hover {
  background: var(--lu-danger, #f04f75);
  color: #fff;
  filter: brightness(0.95);
}
/* 全部重试：橙底白字 */
.capsule button.retry {
  background: var(--lu-warning, #f7903d);
  color: #fff;
}
.capsule button.retry:hover {
  background: var(--lu-warning, #f7903d);
  color: #fff;
  filter: brightness(0.95);
}
.mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  color: #4b5563;
  padding: 0.42em 0.8em;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.mode-btn:hover {
  border-color: var(--lu-primary, #0e8afe);
}
.mode-btn.on {
  border-color: var(--lu-primary, #0e8afe);
  background: #eaf4ff;
  color: var(--lu-primary, #0e8afe);
}
.mode-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #cbd5e1;
}
.mode-btn.on .mode-dot {
  background: var(--lu-primary, #0e8afe);
}
.status-line {
  font-size: 12px;
  color: var(--lu-warning, #f7903d);
  padding: 0 2px;
}
/* 进度显示面板 */
.progress-panel {
  flex: 1;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  color: #8a94a6;
  background: #fbfcfe;
  border-bottom: 1px solid #f1f3f5;
  flex-shrink: 0;
}
.col-name {
  flex: 0 1 34%;
}
.col-status {
  flex: 0 0 64px;
}
.col-out {
  flex: 1;
}
.col-ops {
  flex-shrink: 0;
  width: 150px;
  text-align: right;
}
.pending {
  border-bottom: 1px solid #f1f3f5;
}
.pending .prow {
  padding: 7px 12px;
}
.muted {
  color: #b0b7c3;
}
.main-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.block-title {
  font-size: 12px;
  font-weight: 600;
  color: #555;
  padding: 0 2px 4px;
}
.block {
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  padding: 6px 4px;
}
.progress {
  flex: 1;
  min-height: 80px;
  overflow-y: auto;
}
.progress .empty {
  margin: 0;
  padding: 14px;
  font-size: 12px;
  color: #999;
  text-align: center;
}
.prow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 13px;
  border-bottom: 1px solid #f0f0f0;
}
.prow:last-child {
  border-bottom: none;
}
.p-idx {
  color: #999;
  flex-shrink: 0;
}
.p-name {
  flex: 0 1 40%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-status {
  flex-shrink: 0;
  font-size: 12px;
  color: #666;
}
.p-status.active {
  color: var(--lu-primary, #0e8afe);
}
.p-status.done {
  color: var(--lu-success-ink, #009e80);
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
  font-size: 11px;
  color: #999;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-ops {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.5em 1.1em;
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  background-color: #ffffff;
  border-color: #d4d4d4;
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
button.link.danger {
  color: var(--lu-danger, #f04f75);
}
.notice {
  font-size: 12px;
  color: var(--lu-warning, #f7903d);
}
.hint {
  font-size: 11px;
  color: #999;
}
.token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
}
.token-row label {
  flex-shrink: 0;
  font-weight: 500;
}
.token-row input {
  flex: 1;
  min-width: 180px;
  padding: 0.45em 0.7em;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  border: 1px solid #d4d4d4;
  border-radius: 8px;
  background: #ffffff;
  color: #0f0f0f;
}
.token-row input:disabled {
  opacity: 0.6;
}
.token-hint,
.token-ok {
  font-size: 12px;
  color: var(--lu-success-ink, #009e80);
}
.token-ok {
  font-weight: 500;
}
@media (prefers-color-scheme: dark) {
  .wb {
    color: #f6f6f6;
  }
  .topbar {
    background: #1f1f1f;
    border-bottom-color: #3a3a3a;
  }
  .tb-brand {
    color: #ddd;
  }
  .tb-btn,
  button {
    background-color: #2c2c2c;
    border-color: #444;
    color: #f6f6f6;
  }
  .tb-icon {
    color: #f6f6f6;
  }
  .sidebar {
    background: #1a1a1a;
    border-right-color: #3a3a3a;
  }
  .hist-task {
    border-bottom-color: #2c2c2c;
  }
  .hist-task-row:hover {
    background: #243044;
  }
  .t-date,
  .f-loc,
  .p-status,
  .p-out {
    color: #aaa;
  }
  .search,
  .token-row input {
    background: #2c2c2c;
    border-color: #444;
    color: #f6f6f6;
  }
  .block,
  .progress,
  .log-box {
    border-color: #3a3a3a;
    background: #1f1f1f;
  }
  .prow {
    border-bottom-color: #2c2c2c;
  }
  .log-box {
    color: #ddd;
  }
  .token-hint,
  .token-ok {
    color: var(--lu-success, #00e5b6);
  }
  .brand-name {
    color: #7cc0ff;
  }
  .main {
    background: #141a1f;
  }
  .icon-btn,
  .capsule,
  .mode-btn {
    background: #2c2c2c;
    border-color: #444;
    color: #cbd5e1;
  }
  .capsule button {
    color: #cbd5e1;
  }
  .capsule button + button {
    border-left-color: #444;
  }
  .mode-btn.on {
    background: #16304d;
    border-color: #2b6cb0;
    color: #7cc0ff;
  }
  .progress-panel {
    background: #1f1f1f;
    border-color: #3a3a3a;
  }
  .panel-head {
    background: #232323;
    border-bottom-color: #2c2c2c;
    color: #8a94a6;
  }
  .pending {
    border-bottom-color: #2c2c2c;
  }
  .muted {
    color: #6b7280;
  }
}
</style>

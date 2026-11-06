<script setup lang="ts">
// T5-07 设置页「图片描述」组：多模态（OpenAI 兼容）配置；apiKey 经 secrets。
// 轮 J：新增「提示词方案」——内置 4 套（通用/学术/办公/界面）+ 用户自定义（id 以 User 前缀）。
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { AppConfig, PromptPreset } from "../../core/types";
import { LLM_PROVIDER_PRESETS, matchProvider } from "../../core/config/providers";
import { listModels } from "../../core/client/models";
import { createHttpTransport } from "../../core/platform/http";
import {
  listPromptPresets,
  resolveActivePromptPreset,
  newUserPromptId,
  isUserPromptId,
} from "../../core/caption";

const props = defineProps<{
  cfg: AppConfig;
  onPatch: (fn: (c: AppConfig) => void) => void;
  onSecret: (which: "mineruToken" | "multimodalApiKey", value: string) => void;
}>();

const apiKeyDraft = ref(props.cfg.multimodal.apiKey);

function saveApiKey(): void {
  props.onSecret("multimodalApiKey", apiKeyDraft.value.trim());
}

// ---------------------------------------------------------------- 服务商预设

const providerId = computed(() => matchProvider(props.cfg.multimodal.baseUrl)?.id ?? "custom");
const providerNote = computed(() => matchProvider(props.cfg.multimodal.baseUrl)?.note ?? "");

function selectProvider(e: Event): void {
  const id = (e.target as HTMLSelectElement).value;
  if (id === "custom") return;
  const p = LLM_PROVIDER_PRESETS.find((x) => x.id === id);
  if (!p) return;
  props.onPatch((c) => {
    c.multimodal.baseUrl = p.baseUrl;
    c.multimodal.model = p.model;
  });
}

// ---------------------------------------------------------------- 模型列表（自动拉取）

/** 从 {baseUrl}/models 拉取的候选模型（供输入框下拉选择） */
const modelOptions = ref<string[]>([]);
const modelState = ref<"idle" | "loading" | "ok" | "error">("idle");
const modelMsg = ref("");
let modelTimer: number | null = null;
/** 并发票据：地址/密钥快速变更时，只采纳最后一次请求的结果 */
let modelTicket = 0;
/** 上次成功请求的 baseUrl|apiKey 签名，避免重复拉取 */
let modelSignature = "";

function scheduleModelFetch(delay = 700): void {
  const baseUrl = props.cfg.multimodal.baseUrl.trim();
  const apiKey = props.cfg.multimodal.apiKey.trim();
  if (modelTimer != null) window.clearTimeout(modelTimer);
  if (!baseUrl) {
    modelOptions.value = [];
    modelState.value = "idle";
    modelMsg.value = "";
    return;
  }
  if (!apiKey) {
    modelOptions.value = [];
    modelState.value = "idle";
    modelMsg.value = "填入 API Key 后自动获取可用模型";
    return;
  }
  modelTimer = window.setTimeout(() => {
    modelTimer = null;
    void fetchModels();
  }, delay);
}

/** 拉取模型列表；force=true 时忽略缓存签名（「刷新」按钮） */
async function fetchModels(force = false): Promise<void> {
  const baseUrl = props.cfg.multimodal.baseUrl.trim();
  const apiKey = props.cfg.multimodal.apiKey.trim();
  if (!baseUrl || !apiKey) {
    scheduleModelFetch(0);
    return;
  }
  const signature = `${baseUrl}|${apiKey}`;
  if (!force && signature === modelSignature && modelOptions.value.length > 0) return;
  modelSignature = signature;
  const ticket = ++modelTicket;
  modelState.value = "loading";
  modelMsg.value = "正在获取模型列表…";
  try {
    const ids = await listModels({
      transport: createHttpTransport(props.cfg.http.transport),
      baseUrl,
      apiKey,
    });
    if (ticket !== modelTicket) return;
    modelOptions.value = ids;
    if (ids.length === 0) {
      modelState.value = "error";
      modelMsg.value = "该端点未返回模型列表，请手动填写模型名";
    } else {
      modelState.value = "ok";
      modelMsg.value = `已获取 ${ids.length} 个模型，可从下拉选择或手动填写`;
    }
  } catch (err) {
    if (ticket !== modelTicket) return;
    modelOptions.value = [];
    modelState.value = "error";
    modelMsg.value = err instanceof Error ? err.message : String(err);
  }
}

watch(
  () => [props.cfg.multimodal.baseUrl, props.cfg.multimodal.apiKey, props.cfg.http.transport],
  () => scheduleModelFetch(),
  { immediate: true },
);

/** 从候选下拉中选择模型并填入（含把 select 复位到占位项） */
function pickModel(e: Event): void {
  const el = e.target as HTMLSelectElement;
  const id = el.value;
  if (!id) return;
  props.onPatch((c) => {
    c.multimodal.model = id;
  });
  el.value = "";
}

onBeforeUnmount(() => {
  if (modelTimer != null) window.clearTimeout(modelTimer);
});

// ---------------------------------------------------------------- 提示词方案

const presets = computed<PromptPreset[]>(() => listPromptPresets(props.cfg.multimodal));
const activePreset = computed<PromptPreset>(() => resolveActivePromptPreset(props.cfg.multimodal));
const isUserPreset = computed(() => isUserPromptId(activePreset.value.id));

function labelOf(p: PromptPreset): string {
  return isUserPromptId(p.id) ? `${p.name}（自定义）` : p.name;
}

function selectPreset(e: Event): void {
  const id = (e.target as HTMLSelectElement).value;
  props.onPatch((c) => {
    c.multimodal.activePromptId = id;
  });
}

/** 以当前方案内容为起点新建用户方案，并切换为当前方案 */
function createPreset(): void {
  const base = activePreset.value;
  const id = newUserPromptId();
  const name = `自定义方案 ${props.cfg.multimodal.customPrompts.length + 1}`;
  props.onPatch((c) => {
    c.multimodal.customPrompts.push({ id, name, content: base.content });
    c.multimodal.activePromptId = id;
  });
}

function renamePreset(e: Event): void {
  const name = (e.target as HTMLInputElement).value;
  const id = activePreset.value.id;
  props.onPatch((c) => {
    const p = c.multimodal.customPrompts.find((x) => x.id === id);
    if (p) p.name = name;
  });
}

function editContent(e: Event): void {
  const content = (e.target as HTMLTextAreaElement).value;
  const id = activePreset.value.id;
  props.onPatch((c) => {
    const p = c.multimodal.customPrompts.find((x) => x.id === id);
    if (p) p.content = content;
  });
}

function deletePreset(): void {
  const id = activePreset.value.id;
  if (!isUserPromptId(id)) return;
  props.onPatch((c) => {
    c.multimodal.customPrompts = c.multimodal.customPrompts.filter((x) => x.id !== id);
    if (c.multimodal.activePromptId === id) c.multimodal.activePromptId = "general";
  });
}
</script>

<template>
  <div class="grp">
    <h3 class="grp-title">图片描述</h3>

    <div class="row">
      <label>服务商</label>
      <select :value="providerId" @change="selectProvider">
        <option value="custom">自定义（OpenAI 兼容）</option>
        <option v-for="p in LLM_PROVIDER_PRESETS" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </div>
    <p v-if="providerNote" class="warn">{{ providerNote }}</p>
    <div class="row">
      <label>API 地址</label>
      <input :value="cfg.multimodal.baseUrl" placeholder="OpenAI 兼容端点（如 https://api.deepseek.com）" @input="onPatch((c) => { c.multimodal.baseUrl = ($event.target as HTMLInputElement).value; })" />
    </div>
    <div class="row">
      <label>API Key</label>
      <input v-model="apiKeyDraft" type="password" placeholder="加密存储" autocomplete="off" />
      <button @click="saveApiKey">保存</button>
    </div>
    <div class="row">
      <label>模型</label>
      <input
        :value="cfg.multimodal.model"
        placeholder="填写地址后自动获取，也可手动填写"
        @input="onPatch((c) => { c.multimodal.model = ($event.target as HTMLInputElement).value; })"
      />
      <button :disabled="modelState === 'loading'" @click="fetchModels(true)">
        {{ modelState === "loading" ? "获取中…" : "刷新模型" }}
      </button>
    </div>
    <!-- D-96：原生 datalist 会按输入框当前值过滤候选，导致「拉到 N 个却只显示 1 个」；改为显式下拉 -->
    <div v-if="modelOptions.length > 0" class="row">
      <label>候选模型</label>
      <select :value="''" @change="pickModel">
        <option value="">选择后填入上方（共 {{ modelOptions.length }} 个）</option>
        <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
      </select>
    </div>
    <p v-if="modelMsg" class="hint" :class="{ err: modelState === 'error' }">{{ modelMsg }}</p>
    <div class="row">
      <label>并发数</label>
      <input type="number" min="1" max="16" :value="cfg.multimodal.concurrency" @change="onPatch((c) => { c.multimodal.concurrency = Number(($event.target as HTMLInputElement).value) || 1; })" />
    </div>
    <div class="row">
      <label>单张上限</label>
      <input type="number" min="0" :value="cfg.multimodal.maxImages" placeholder="0 = 不限" @change="onPatch((c) => { c.multimodal.maxImages = Number(($event.target as HTMLInputElement).value) || 0; })" />
    </div>

    <h4 class="sub-title">提示词方案</h4>
    <div class="row">
      <label>方案</label>
      <select :value="cfg.multimodal.activePromptId" @change="selectPreset">
        <option v-for="p in presets" :key="p.id" :value="p.id">{{ labelOf(p) }}</option>
      </select>
      <button @click="createPreset">新建方案</button>
    </div>
    <div v-if="isUserPreset" class="row">
      <label>方案名称</label>
      <input :value="activePreset.name" placeholder="给这套提示词起个名字" @input="renamePreset" />
      <button class="danger" @click="deletePreset">删除</button>
    </div>
    <div class="row col">
      <label>提示词内容</label>
      <textarea
        :value="activePreset.content"
        :readonly="!isUserPreset"
        :class="{ readonly: !isUserPreset }"
        rows="10"
        placeholder="自定义提示词内容"
        @input="editContent"
      ></textarea>
    </div>
  </div>
</template>

<style scoped>
.grp-title { font-size: 15px; margin: 0 0 12px; }
.sub-title { font-size: 13px; margin: 18px 0 8px; padding-top: 12px; border-top: 1px solid #eee; color: #333; }
.row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 13px; }
.row.col { align-items: flex-start; }
.row label { flex: 0 0 110px; color: #555; }
.row input:not([type="checkbox"]), .row select, .row textarea { flex: 1; min-width: 0; padding: 0.4em 0.6em; font-size: 13px; border: 1px solid #d4d4d4; border-radius: 8px; background: #fff; color: #0f0f0f; }
.row textarea { font-family: inherit; line-height: 1.55; resize: vertical; }
.row textarea.readonly { background: #f7f7f7; color: #555; }
.row button { border-radius: 8px; border: 1px solid var(--lu-primary, #0e8afe); background: var(--lu-primary, #0e8afe); color: #fff; padding: 0.4em 0.9em; font-size: 13px; cursor: pointer; }
.row button.danger { background: #fff; border-color: var(--lu-danger, #f04f75); color: var(--lu-danger, #f04f75); }
.warn { font-size: 12px; color: var(--lu-warning, #f7903d); margin: 4px 0 0 120px; line-height: 1.5; }
.hint { font-size: 12px; color: #999; margin: 8px 0 0; line-height: 1.6; }
.hint.err { color: var(--lu-danger, #f04f75); }
.hint code { background: #f0f0f0; padding: 0 4px; border-radius: 4px; }
@media (prefers-color-scheme: dark) {
  .row label, .sub-title { color: #aaa; }
  .sub-title { border-top-color: #3a3a3a; }
  .warn { color: #ffb066; }
  .row input, .row select, .row textarea { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .row textarea.readonly { background: #262626; color: #bbb; }
  .row button.danger { background: #2c2c2c; border-color: var(--lu-danger, #f04f75); color: #ff8a8a; }
  .hint code { background: #333; }
}
</style>

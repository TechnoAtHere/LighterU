<script setup lang="ts">
// T5-07/T5-09 设置页「MinerU」组：双模式（精准 / Agent 轻量）+ Token + 解析选项 + 输出格式。
import { computed, ref } from "vue";
import { sanitizeToken } from "../../core/config";
import type { AppConfig, MineruApiMode } from "../../core/types";

const props = defineProps<{
  cfg: AppConfig;
  onPatch: (fn: (c: AppConfig) => void) => void;
  onSecret: (which: "mineruToken" | "multimodalApiKey", value: string) => void;
}>();

const tokenDraft = ref(props.cfg.mineru.token);

function saveToken(): void {
  // 轮 I（#2）：清洗为非 ASCII 之外的字符（去空格/零宽/全角/换行），避免 Headers 构造失败/403
  const clean = sanitizeToken(tokenDraft.value);
  tokenDraft.value = clean;
  props.onSecret("mineruToken", clean);
  // 轮 J：保存 Token 即重置 90 天计时
  props.onPatch((c) => {
    c.mineru.tokenSavedAt = Date.now();
  });
}

/** 用系统默认浏览器打开外部网址；非 Tauri 回退 window.open（修复：原先误用 openPath）。 */
async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      // 完全不可用时静默
    }
  }
}

function openTokenSite(): void {
  void openExternal("https://mineru.net/apiManage/token");
}

/** MinerU 官方文档站（安装 / 输出格式 / SDK / CLI 等完整说明） */
function openDocs(): void {
  void openExternal("https://opendatalab.github.io/MinerU/");
}

/** 开放平台 API 文档（接口字段、状态说明、错误码） */
function openApiDocs(): void {
  void openExternal("https://mineru.net/apiManage/docs");
}

// ---------------------------------------------------------------- 模式

function setMode(mode: MineruApiMode): void {
  props.onPatch((c) => {
    c.mineru.apiMode = mode;
  });
}

// ---------------------------------------------------------------- Token 90 天计时

const tokenAgeDays = computed(() => {
  const t = props.cfg.mineru.tokenSavedAt;
  if (!t) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
});
const tokenHasTimer = computed(() => props.cfg.mineru.tokenSavedAt > 0);
const tokenExpired = computed(() => tokenAgeDays.value >= 90);

// ---------------------------------------------------------------- 解析选项（按文档给选项）

const MODEL_VERSIONS = [
  { value: "pipeline", label: "pipeline（默认）" },
  { value: "vlm", label: "vlm（推荐）" },
  { value: "MinerU-HTML", label: "MinerU-HTML" },
];

const LANGUAGES = [
  { value: "ch", label: "中文（ch）" },
  { value: "en", label: "英文（en）" },
  { value: "chinese_cht", label: "繁体中文（chinese_cht）" },
  { value: "japan", label: "日文（japan）" },
  { value: "korean", label: "韩文（korean）" },
  { value: "latin", label: "拉丁语系（latin）" },
  { value: "arabic", label: "阿拉伯语（arabic）" },
  { value: "cyrillic", label: "西里尔语系（cyrillic）" },
  { value: "devanagari", label: "天城文（devanagari）" },
];

function setParse(patch: (p: AppConfig["mineru"]["parse"]) => void): void {
  props.onPatch((c) => patch(c.mineru.parse));
}
</script>

<template>
  <div class="grp">
    <h3 class="grp-title">MinerU</h3>

    <!-- 模式选择（复选框，互斥） -->
    <div class="mode-cards">
      <label class="mode-card" :class="{ active: cfg.mineru.apiMode === 'precise' }" @click.prevent="setMode('precise')">
        <input type="checkbox" :checked="cfg.mineru.apiMode === 'precise'" tabindex="-1" @click.prevent.stop />
        <span class="mc-text">
          <span class="mc-title">精准解析 API</span>
          <span class="mc-sub">需要 Token · ≤200MB / ≤200 页 · 支持批量</span>
        </span>
      </label>
      <label class="mode-card" :class="{ active: cfg.mineru.apiMode === 'agent' }" @click.prevent="setMode('agent')">
        <input type="checkbox" :checked="cfg.mineru.apiMode === 'agent'" tabindex="-1" @click.prevent.stop />
        <span class="mc-text">
          <span class="mc-title">Agent 轻量解析 API</span>
          <span class="mc-sub">免 Token · 单次 ≤10MB · 长 PDF 自动拆分</span>
        </span>
      </label>
    </div>

    <!-- ================= 精准解析 API ================= -->
    <template v-if="cfg.mineru.apiMode === 'precise'">
      <table class="info-table">
        <tbody>
          <tr><th>是否需要 Token</th><td>✅ 需要</td></tr>
          <tr><th>接口地址</th><td>/api/v4/extract/task 或 /api/v4/file-urls/batch</td></tr>
          <tr><th>模型版本</th><td>pipeline（默认）/ vlm（推荐）/ MinerU-HTML</td></tr>
          <tr><th>文件大小限制</th><td>≤ 200MB</td></tr>
          <tr><th>页数限制</th><td>≤ 200 页</td></tr>
          <tr><th>批量支持</th><td>✅ 支持（≤ 200 个）</td></tr>
          <tr><th>输出格式</th><td>Zip 包（Markdown、JSON），可导出 docx / html / latex</td></tr>
          <tr><th>调用方式</th><td>异步（提交 → 轮询）</td></tr>
        </tbody>
      </table>

      <div class="row">
        <label>API 地址</label>
        <input :value="cfg.mineru.baseUrl" @input="onPatch((c) => { c.mineru.baseUrl = ($event.target as HTMLInputElement).value; })" />
      </div>
      <div class="row">
        <label>Token</label>
        <input v-model="tokenDraft" type="password" placeholder="sk-…" autocomplete="off" />
        <button @click="saveToken">保存</button>
        <button class="link-btn" type="button" @click="openTokenSite">获取 Token</button>
      </div>
      <div class="token-timer" :class="{ expired: tokenExpired }">
        <template v-if="tokenHasTimer">
          上次修改后的API据本地统计已使用 <b>{{ tokenAgeDays }}</b> 天 / 90 天，按官方要求自申请时起 90 天后需重新申请 API
          <span v-if="tokenExpired">（已过期，请重新申请 API Token）</span>
        </template>
        <template v-else>保存 Token 后开始计时；Token 有效期 90 天，到期需重新申请。</template>
      </div>

      <div class="sub-row">
        <div class="sub">解析选项</div>
        <span class="doc-links">
          <button class="link-btn" type="button" @click="openDocs">打开官方文档</button>
          <button class="link-btn" type="button" @click="openApiDocs">API 文档</button>
        </span>
      </div>
      <div class="row">
        <label>强制启用图片识别</label>
        <input type="checkbox" :checked="cfg.mineru.parse.isOcr" @change="setParse((p) => { p.isOcr = ($event.target as HTMLInputElement).checked; })" />
      </div>
      <div class="row">
        <label>识别表格</label>
        <input type="checkbox" :checked="cfg.mineru.parse.enableTable" @change="setParse((p) => { p.enableTable = ($event.target as HTMLInputElement).checked; })" />
      </div>
      <div class="row">
        <label>识别公式</label>
        <input type="checkbox" :checked="cfg.mineru.parse.enableFormula" @change="setParse((p) => { p.enableFormula = ($event.target as HTMLInputElement).checked; })" />
      </div>
      <div class="row">
        <label>模型版本</label>
        <select :value="cfg.mineru.parse.modelVersion" @change="setParse((p) => { p.modelVersion = ($event.target as HTMLSelectElement).value; })">
          <option v-for="m in MODEL_VERSIONS" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
      </div>
      <div class="row">
        <label>识别语言</label>
        <select :value="cfg.mineru.parse.language" @change="setParse((p) => { p.language = ($event.target as HTMLSelectElement).value; })">
          <option v-for="l in LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
      </div>
      <div class="row">
        <label>页码范围</label>
        <input :value="cfg.mineru.parse.pageRanges" placeholder="空 = 全量；如 1-10,15" @input="setParse((p) => { p.pageRanges = ($event.target as HTMLInputElement).value; })" />
      </div>
      <!-- D-98：输出格式（Markdown/JSON/DOCX/HTML/图片/全部）已迁移到「输出 → 默认输出格式」多选 -->
    </template>

    <!-- ================= Agent 轻量解析 API ================= -->
    <template v-else>
      <table class="info-table">
        <tbody>
          <tr><th>是否需要 Token</th><td>❌ 无需（IP 限频）</td></tr>
          <tr><th>接口地址</th><td>/api/v1/agent/parse/url 或 /api/v1/agent/parse/file</td></tr>
          <tr><th>模型版本</th><td>固定 pipeline 轻量模型</td></tr>
          <tr><th>文件大小限制</th><td>≤ 10MB / 每次上传</td></tr>
          <tr><th>页数限制</th><td>每片 ≤ 20 页；超过时自动拆分、逐片解析并合并</td></tr>
          <tr><th>批量支持</th><td>❌ 多文件批量（长 PDF 自动分片）</td></tr>
          <tr><th>输出格式</th><td>仅 Markdown（CDN 链接）</td></tr>
          <tr><th>调用方式</th><td>异步（提交 → 轮询）</td></tr>
        </tbody>
      </table>

      <p class="agent-note">无需 Token，按 IP 限频；超出限制返回 HTTP 429。仅输出 Markdown。超过 20 页的 PDF 会自动按 20 页一片拆分、逐片上传并合并为一份结果；分片较多时可能触发限频，客户端会自动退避重试。</p>

      <div class="sub-row">
        <div class="sub">解析选项</div>
        <span class="doc-links">
          <button class="link-btn" type="button" @click="openDocs">打开官方文档</button>
          <button class="link-btn" type="button" @click="openApiDocs">API 文档</button>
        </span>
      </div>
      <div class="row">
        <label>识别语言</label>
        <select :value="cfg.mineru.parse.language" @change="setParse((p) => { p.language = ($event.target as HTMLSelectElement).value; })">
          <option v-for="l in LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
      </div>
      <div class="row">
        <label>页码范围</label>
        <input :value="cfg.mineru.parse.pageRanges" placeholder="单段，如 1-20（≤20 页）" @input="setParse((p) => { p.pageRanges = ($event.target as HTMLInputElement).value; })" />
      </div>
    </template>

  </div>
</template>

<style scoped>
.grp-title { font-size: 15px; margin: 0 0 12px; }
.mode-cards { display: flex; gap: 10px; margin-bottom: 12px; }
.mode-card {
  flex: 1;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
}
.mode-card.active { border-color: var(--lu-primary, #0e8afe); background: var(--lu-primary-weak, #eaf4ff); }
.mode-card input { margin-top: 2px; }
.mc-text { display: flex; flex-direction: column; gap: 3px; }
.mc-title { font-size: 13px; font-weight: 700; color: #1f2937; }
.mc-sub { font-size: 11px; color: #8a94a6; }
.info-table { width: 100%; border-collapse: collapse; margin: 4px 0 10px; font-size: 12px; }
.info-table th, .info-table td { border: 1px solid #eceff3; padding: 6px 8px; text-align: left; vertical-align: top; }
.info-table th { width: 118px; color: #6b7280; font-weight: 600; background: #fbfcfe; }
.info-table td { color: #374151; word-break: break-word; }
.agent-note { font-size: 12px; color: #8a94a6; margin: 0 0 8px; }
.token-timer { font-size: 12px; color: #6b7280; margin: 2px 0 0 120px; }
.token-timer b { color: var(--lu-primary, #0e8afe); }
.token-timer.expired { color: var(--lu-danger, #f04f75); font-weight: 600; }
.sub-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 14px 0 6px; }
.sub { font-size: 13px; font-weight: 600; color: #555; margin: 14px 0 6px; }
.sub-row .sub { margin: 0; }
.row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 13px; }
.row label { flex: 0 0 110px; color: #555; }
.row input:not([type="checkbox"]), .row select { flex: 1; min-width: 0; padding: 0.4em 0.6em; font-size: 13px; border: 1px solid #d4d4d4; border-radius: 8px; background: #fff; color: #0f0f0f; }
.row button { border-radius: 8px; border: 1px solid var(--lu-primary, #0e8afe); background: var(--lu-primary, #0e8afe); color: #fff; padding: 0.4em 0.9em; font-size: 13px; cursor: pointer; }
.link-btn { border: none; background: none; color: var(--lu-primary, #0e8afe); font-size: 13px; cursor: pointer; padding: 0.4em 0.5em; text-decoration: underline; }
.doc-links { display: inline-flex; align-items: center; gap: 8px; }
.checks { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.chk { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: #374151; }
@media (prefers-color-scheme: dark) {
  .mode-card { background: #2c2c2c; border-color: #444; }
  .mode-card.active { background: #16304d; border-color: #2b6cb0; }
  .mc-title { color: #e8e8e8; }
  .info-table th { background: #232323; color: #aaa; }
  .info-table th, .info-table td { border-color: #3a3a3a; }
  .info-table td { color: #cbd5e1; }
  .sub { color: #aaa; }
  .row label { color: #aaa; }
  .row input, .row select { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .chk { color: #cbd5e1; }
  .link-btn { color: #8fb0f0; }
}
</style>

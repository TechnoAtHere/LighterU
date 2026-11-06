<script setup lang="ts">
// T5-07 设置页容器（主工作站同窗页面切换，D-61/UI 规格 §3）：顶栏 + 左侧四组导航 + 右侧内容。
// 配置加载/保存经 core/config；密钥（Token/apiKey）经 secrets 适配器，不明文落盘（D-19）。
// 不改解析链路核心；仅承载配置。四个子组件：MinerU / 图片描述 / 输出 / 通用。
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { loadConfig, saveConfig } from "../../core/config";
import { createConfigStore } from "../../core/platform/store";
import { createSecretsAdapter, SECRET_KEYS } from "../../core/platform/secrets";
import SettingsMineru from "./SettingsMineru.vue";
import SettingsCaption from "./SettingsCaption.vue";
import SettingsOutput from "./SettingsOutput.vue";
import SettingsLog from "./SettingsLog.vue";
import Icon from "../components/Icon.vue";
import logoUrl from "../../assets/logo.svg";
import { DEFAULT_CONFIG } from "../../core/config/defaults";
import type { AppConfig } from "../../core/types";

type GroupKey = "mineru" | "caption" | "output" | "log" | "about";

const props = defineProps<{ initialGroup?: GroupKey }>();

const emit = defineEmits<{ (e: "close"): void }>();

const GITHUB_URL = "https://github.com/TechnoAtHere/LighterU";
const GITEE_URL = "https://gitee.com/ATWWW/LighterU";
const version = typeof __LU_VERSION__ !== "undefined" ? __LU_VERSION__ : "dev";

/** 用系统默认浏览器打开外部链接；非 Tauri 回退 window.open */
async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      // 忽略
    }
  }
}

const cfg = ref<AppConfig | null>(null);
const loading = ref(true);
const active = ref<GroupKey>("mineru");
const msg = ref("");
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: "mineru", label: "MinerU" },
  { key: "caption", label: "图片描述" },
  { key: "output", label: "输出" },
  { key: "log", label: "日志" },
  { key: "about", label: "关于" },
];

onMounted(async () => {
  try {
    cfg.value = await loadConfig({ store: createConfigStore(), secrets: createSecretsAdapter() });
  } catch (err) {
    msg.value = `配置加载失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    loading.value = false;
  }
});

// 通知面板的「去设置」动作可携带目标分组，挂载或变更时跳转
watch(
  () => props.initialGroup,
  (g) => {
    if (g) active.value = g
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (saveTimer != null) clearTimeout(saveTimer);
});

// 任意字段变更 → 防抖自动保存（stripSecrets 已 JSON 往返穿透 reactive Proxy，D-10/D-55）
watch(
  cfg,
  () => {
    if (!cfg.value) return;
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 500);
  },
  { deep: true },
);

async function save(): Promise<void> {
  if (!cfg.value) return;
  try {
    await saveConfig({ store: createConfigStore(), secrets: createSecretsAdapter() }, cfg.value);
    msg.value = "已保存";
  } catch (err) {
    msg.value = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 重置为默认设置（保留已保存的密钥，避免重置后还要重新填 token/apiKey） */
function resetSettings(): void {
  if (!cfg.value) return;
  const next = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
  next.mineru.token = cfg.value.mineru.token;
  next.multimodal.apiKey = cfg.value.multimodal.apiKey;
  cfg.value = next;
  msg.value = "已重置为默认设置（密钥保留）";
}

function onPatch(fn: (c: AppConfig) => void): void {
  if (cfg.value) fn(cfg.value);
}

// 密钥字段：写 secrets 适配器 + 同步内存态（不随 config 落盘）
async function saveSecret(which: "mineruToken" | "multimodalApiKey", value: string): Promise<void> {
  if (!cfg.value) return;
  try {
    const secrets = createSecretsAdapter();
    if (value) await secrets.set(which === "mineruToken" ? SECRET_KEYS.mineruToken : SECRET_KEYS.multimodalApiKey, value);
    else await secrets.delete(which === "mineruToken" ? SECRET_KEYS.mineruToken : SECRET_KEYS.multimodalApiKey);
    if (which === "mineruToken") cfg.value.mineru.token = value;
    else cfg.value.multimodal.apiKey = value;
    msg.value = value ? "密钥已保存（加密存储）" : "密钥已清除";
  } catch (err) {
    msg.value = `密钥保存失败：${err instanceof Error ? err.message : String(err)}`;
  }
}
</script>

<template>
  <div class="settings">
    <header class="sp-top">
      <div class="sp-top-left">
        <button class="sp-logo-btn" title="返回主页面" @click="emit('close')">
          <img class="sp-logo" :src="logoUrl" alt="LighterU" />
        </button>
        <button class="sp-icon-btn" title="重置设置" @click="resetSettings">
          <Icon name="refresh-ccw" :size="17" />
        </button>
      </div>
      <div class="sp-top-right">
        <button class="sp-return" title="返回" @click="emit('close')">
          <Icon name="corner-up-left" :size="16" />返回
        </button>
      </div>
    </header>

    <div class="sp-body">
      <aside class="sp-nav">
        <button
          v-for="g in GROUPS"
          :key="g.key"
          class="sp-nav-item"
          :class="{ active: active === g.key }"
          @click="active = g.key"
        >
          {{ g.label }}
        </button>
        <div class="sp-nav-search">
          <input type="search" placeholder="搜索设置…（即将支持）" disabled />
        </div>
      </aside>

      <section class="sp-content">
        <p v-if="msg" class="sp-msg">{{ msg }}</p>
        <p v-if="loading" class="sp-loading">加载中…</p>
        <template v-else-if="cfg">
          <SettingsMineru v-if="active === 'mineru'" :cfg="cfg" :on-patch="onPatch" :on-secret="saveSecret" />
          <SettingsCaption v-else-if="active === 'caption'" :cfg="cfg" :on-patch="onPatch" :on-secret="saveSecret" />
          <SettingsOutput v-else-if="active === 'output'" :cfg="cfg" :on-patch="onPatch" />
          <SettingsLog v-else-if="active === 'log'" :cfg="cfg" :on-patch="onPatch" />
          <div v-else-if="active === 'about'" class="about">
            <h3 class="about-title">LighterU <span class="about-ver">v{{ version }}</span></h3>
            <p class="about-desc">更轻、更快、链条更短地将文件转换为 AI 可读形式的 Windows 桌面端 MinerU 解析客户端。</p>
            <div class="about-links">
              <button class="about-link" @click="openExternal(GITHUB_URL)">GitHub</button>
              <button class="about-link" @click="openExternal(GITEE_URL)">Gitee</button>
            </div>
            <p class="about-note">非官方客户端，与 MinerU / OpenDataLab 无隶属关系。MIT License。</p>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden; text-align: left; color: #0f0f0f; }
.sp-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 14px; min-height: 48px; box-sizing: border-box; border-bottom: 1px solid #e5e5e5; background: #fff; flex-shrink: 0; }
.sp-top-left, .sp-top-right { display: flex; align-items: center; gap: 8px; }
.sp-brand { font-size: 13px; font-weight: 600; color: #333; }
.sp-btn { border-radius: 8px; border: 1px solid #d4d4d4; padding: 0.35em 0.8em; font-size: 13px; cursor: pointer; background: #fff; color: #0f0f0f; }
.sp-btn.primary { background: var(--lu-primary, #0e8afe); border-color: var(--lu-primary, #0e8afe); color: #fff; }
.sp-logo-btn { border: none; background: none; padding: 2px 4px; cursor: pointer; }
.sp-logo { width: 26px; height: 30px; object-fit: contain; display: block; }
.sp-icon-btn {
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
.sp-icon-btn:hover { border-color: var(--lu-primary, #0e8afe); color: var(--lu-primary, #0e8afe); background: #f2f8ff; }
.sp-return {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #e5e7eb;
  background: #fff;
  color: #374151;
  border-radius: 9px;
  padding: 0.35em 0.8em;
  font-size: 13px;
  cursor: pointer;
}
.sp-return:hover { border-color: var(--lu-primary, #0e8afe); color: var(--lu-primary, #0e8afe); background: #f2f8ff; }
.sp-body { flex: 1; display: flex; min-height: 0; }
.sp-nav { width: 200px; flex-shrink: 0; border-right: 1px solid #e5e5e5; background: #fafafa; display: flex; flex-direction: column; padding: 10px 8px; gap: 4px; }
.sp-nav-item { border: none; background: none; text-align: left; padding: 0.5em 0.8em; border-radius: 8px; font-size: 13px; cursor: pointer; color: #333; }
.sp-nav-item:hover { background: #f0f4fb; }
.sp-nav-item.active { background: var(--lu-primary, #0e8afe); color: #fff; }
.sp-nav-search { margin-top: auto; }
.sp-nav-search input { width: 100%; box-sizing: border-box; padding: 0.4em 0.6em; font-size: 12px; border: 1px solid #d4d4d4; border-radius: 8px; background: #fff; color: #0f0f0f; }
.sp-content { flex: 1; min-width: 0; overflow-y: auto; padding: 14px 18px; }
.sp-msg { margin: 0 0 10px; font-size: 12px; color: var(--lu-success-ink, #009e80); }
.sp-loading { font-size: 13px; color: #999; }
.about { max-width: 560px; }
.about-title { font-size: 15px; margin: 0 0 8px; }
.about-ver { font-size: 12px; font-weight: 400; color: #8a94a6; margin-left: 6px; }
.about-desc { font-size: 13px; color: #4b5563; line-height: 1.6; margin: 0 0 14px; }
.about-links { display: flex; gap: 8px; margin-bottom: 14px; }
.about-link { border: 1px solid #d4d4d4; background: #fff; color: #0f0f0f; border-radius: 8px; padding: 0.4em 0.9em; font-size: 13px; cursor: pointer; }
.about-link:hover { border-color: var(--lu-primary, #0e8afe); color: var(--lu-primary, #0e8afe); }
.about-note { font-size: 12px; color: #8a94a6; margin: 0; }
@media (prefers-color-scheme: dark) {
  .settings { color: #f6f6f6; }
  .sp-top { background: #1f1f1f; border-bottom-color: #3a3a3a; }
  .sp-brand { color: #ddd; }
  .sp-btn { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .sp-icon-btn,
  .sp-return { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .sp-nav { background: #1a1a1a; border-right-color: #3a3a3a; }
  .sp-nav-item { color: #ddd; }
  .sp-nav-item:hover { background: #243044; }
  .sp-nav-search input { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .about-desc { color: #cbd5e1; }
  .about-link { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .about-note, .about-ver { color: #9aa3af; }
}
</style>

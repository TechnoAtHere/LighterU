<script setup lang="ts">
// 轮 G 日志重构（T4）：设置页「日志」组——调试日志开关、容量上限、打开目录、清空。
import type { AppConfig } from "../../core/types";
import { getLogDir, setDebugEnabled, clearLogs } from "../../core/platform/logger";
import { ref } from "vue";

const props = defineProps<{
  cfg: AppConfig;
  onPatch: (fn: (c: AppConfig) => void) => void;
}>();

const msg = ref("");

function onToggleDebug(e: Event): void {
  const checked = (e.target as HTMLInputElement).checked;
  // 立即应用到 logger（运行中的日志行为随之变化）
  setDebugEnabled(checked);
  // 持久化到 config.logging.debugEnabled（父组件 watch 防抖保存）
  props.onPatch((c) => {
    c.logging.debugEnabled = checked;
  });
  msg.value = checked ? "调试日志已开启（全量含调试/追踪将落盘）" : "调试日志已关闭（仅记录关键链路 info/警告/错误）";
}

function onMaxSize(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value) || 50;
  props.onPatch((c) => {
    c.logging.maxSizeMB = Math.min(1024, Math.max(1, v));
  });
}

async function openDir(): Promise<void> {
  const dir = getLogDir();
  if (!dir) {
    msg.value = "日志目录不可用（非 Tauri 或未初始化）";
    return;
  }
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(dir);
  } catch (err) {
    msg.value = `打开目录失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

async function clearAll(): Promise<void> {
  const n = await clearLogs();
  msg.value = `已清空调试日志（删除 ${n} 个文件）`;
}
</script>

<template>
  <div class="grp">
    <h3 class="grp-title">日志</h3>

    <div class="row">
      <label>调试日志</label>
      <span class="ctl">
        <input type="checkbox" :checked="cfg.logging.debugEnabled" @change="onToggleDebug" />
        <span class="state">{{ cfg.logging.debugEnabled ? "已开启（全量含调试/追踪）" : "已关闭（仅关键链路）" }}</span>
      </span>
    </div>
    <div class="row">
      <label>容量上限 (MB)</label>
      <input
        type="number"
        min="1"
        max="1024"
        :value="cfg.logging.maxSizeMB"
        @change="onMaxSize"
      />
    </div>
    <div class="row">
      <label>调试日志目录</label>
      <span class="ctl">
        <button class="lnk" @click="openDir">打开目录</button>
        <button class="lnk danger" @click="clearAll">清空日志</button>
      </span>
    </div>
    <p v-if="msg" class="msg">{{ msg }}</p>
  </div>
</template>

<style scoped>
.grp-title { font-size: 15px; margin: 0 0 12px; }
.row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 13px; }
.row label { flex: 0 0 120px; color: #555; }
.row input[type="number"] { flex: 1; min-width: 0; padding: 0.4em 0.6em; font-size: 13px; border: 1px solid #d4d4d4; border-radius: 8px; background: #fff; color: #0f0f0f; }
.ctl { display: flex; align-items: center; gap: 10px; flex: 1; }
.state { font-size: 12px; color: #888; }
.lnk { border: 1px solid #d4d4d4; background: #fff; border-radius: 8px; padding: 0.3em 0.7em; font-size: 12px; cursor: pointer; color: #333; }
.lnk.danger { border-color: var(--lu-danger, #f04f75); color: var(--lu-danger, #f04f75); }
.hint { font-size: 12px; color: #999; margin: 8px 0 0; line-height: 1.6; }
.msg { font-size: 12px; color: var(--lu-success-ink, #009e80); margin: 8px 0 0; }
@media (prefers-color-scheme: dark) {
  .row label { color: #aaa; }
  .row input[type="number"] { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .lnk { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .lnk.danger { border-color: var(--lu-danger, #f04f75); color: #ff8a8a; }
  .state { color: #aaa; }
}
</style>

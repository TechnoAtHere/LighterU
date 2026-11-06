<script setup lang="ts">
// T5-02/T5-05 设置页「输出」组。
// 轮 I（#7）：由「点击切换页签」改为纵向流式排列——通用 / 右键入口 / 工作站入口 一次全部展示。
import { onMounted, ref } from "vue";
import type { AppConfig, OutputEntryConfig, OutputKind, SameNameHandling } from "../../core/types";
import { isTauri } from "../../core/platform/env";

const props = defineProps<{
  cfg: AppConfig;
  onPatch: (fn: (c: AppConfig) => void) => void;
}>();

// 右键菜单手动开关：读取实际注册状态；切换时调用 Rust 命令并持久化（重启后仍尊重该选择）。
const ctxMenuEnabled = ref(true);
const ctxMenuBusy = ref(false);

async function refreshContextMenuState(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    ctxMenuEnabled.value = await invoke<boolean>("lu_is_context_menu_registered");
  } catch {
    // 读取失败时保持当前显示
  }
}

async function toggleContextMenu(enabled: boolean): Promise<void> {
  if (!isTauri()) {
    ctxMenuEnabled.value = enabled;
    return;
  }
  ctxMenuBusy.value = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    ctxMenuEnabled.value = await invoke<boolean>("lu_set_context_menu", { enabled });
  } catch (e) {
    console.error("[lu] 右键菜单切换失败", e);
    await refreshContextMenuState();
  } finally {
    ctxMenuBusy.value = false;
  }
}

onMounted(() => {
  void refreshContextMenuState();
});

type EntryKey = "rightClick" | "workbench";
const sections: Array<{ key: EntryKey; label: string }> = [
  { key: "rightClick", label: "右键入口（直接解析）" },
  { key: "workbench", label: "工作站入口" },
];

/** D-98：输出内容多选（「全部」为全选快捷项，不单独存储） */
const ALL_KINDS: OutputKind[] = ["markdown", "json", "docx", "html", "images"];
const KIND_OPTIONS: Array<{ key: OutputKind | "all"; label: string }> = [
  { key: "markdown", label: "Markdown" },
  { key: "json", label: "JSON" },
  { key: "docx", label: "DOCX" },
  { key: "html", label: "HTML" },
  { key: "images", label: "图片" },
  { key: "all", label: "全部" },
];

function setEntryField(key: EntryKey, field: keyof OutputEntryConfig, value: unknown): void {
  props.onPatch((c) => {
    (c.output[key] as unknown as Record<string, unknown>)[field] = value;
  });
}

function entryOutputs(key: EntryKey): OutputKind[] {
  return props.cfg.output[key].outputs ?? ["markdown"];
}

function isAllSelected(key: EntryKey): boolean {
  const list = entryOutputs(key);
  return ALL_KINDS.every((k) => list.includes(k));
}

/** 「全部」选中时其余项不可单独取消 */
function isKindDisabled(key: EntryKey, kind: OutputKind | "all"): boolean {
  if (kind === "all") return false;
  return isAllSelected(key);
}

function toggleKind(key: EntryKey, kind: OutputKind | "all", checked: boolean): void {
  let next: OutputKind[];
  if (kind === "all") {
    next = checked ? [...ALL_KINDS] : ["markdown"];
  } else {
    const set = new Set(entryOutputs(key));
    if (checked) set.add(kind);
    else set.delete(kind);
    // 「图片」为显式选择：DOCX 自带图片，勾选 DOCX 不再自动带上「图片」。
    next = ALL_KINDS.filter((k) => set.has(k));
    if (next.length === 0) next = ["markdown"];
  }
  setEntryField(key, "outputs", next);
  setEntryField(key, "format", next.length === 1 && next[0] === "markdown" ? "markdown" : "all");
}

function setSameName(value: string): void {
  props.onPatch((c) => {
    c.output.sameNameHandling = (value === "overwrite" ? "overwrite" : "suffix") as SameNameHandling;
  });
}
</script>

<template>
  <div class="grp">
    <h3 class="grp-title">输出</h3>

    <!-- 通用：失败重试上限 / 队列并发 / 同名输出目录 -->
    <section class="sect">
      <h4 class="sect-title">通用</h4>
      <div class="row">
        <label>失败重试上限</label>
        <input type="number" min="0" max="10" :value="cfg.tasks.maxRetries" @change="onPatch((c) => { c.tasks.maxRetries = Number(($event.target as HTMLInputElement).value) || 0; })" />
      </div>
      <div class="row">
        <label>队列并发</label>
        <input type="number" min="1" max="8" :value="cfg.tasks.queueConcurrency" @change="onPatch((c) => { c.tasks.queueConcurrency = Number(($event.target as HTMLInputElement).value) || 1; })" />
      </div>
      <div class="row">
        <label>同名输出目录</label>
        <select :value="cfg.output.sameNameHandling" @change="setSameName(($event.target as HTMLSelectElement).value)">
          <option value="suffix">追加序号（_N）</option>
          <option value="overwrite">覆盖同名目录</option>
        </select>
      </div>
      <p class="hint">「失败重试上限」「队列并发」作用于所有入口；「同名输出目录」两入口通用。</p>
    </section>

    <!-- 右键入口 / 工作站入口：默认目录 / 格式 / 描述写入 / 自动打开 / 图片描述默认启用（右键附 进度窗自动关闭） -->
    <section v-for="s in sections" :key="s.key" class="sect">
      <h4 class="sect-title">{{ s.label }}</h4>
      <div v-if="s.key === 'rightClick'" class="row">
        <label>启用右键菜单</label>
        <input
          type="checkbox"
          :checked="ctxMenuEnabled"
          :disabled="ctxMenuBusy"
          @change="toggleContextMenu(($event.target as HTMLInputElement).checked)"
        />
      </div>
      <div class="row">
        <label>默认输出目录</label>
        <input
          :value="cfg.output[s.key].defaultDir"
          placeholder="空 = 源文件同目录 / 工作区目录"
          @input="setEntryField(s.key, 'defaultDir', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="row">
        <label>默认输出格式</label>
        <span class="checks">
          <label v-for="o in KIND_OPTIONS" :key="o.key" class="chk">
            <input
              type="checkbox"
              :checked="o.key === 'all' ? isAllSelected(s.key) : entryOutputs(s.key).includes(o.key)"
              :disabled="isKindDisabled(s.key, o.key)"
              @change="toggleKind(s.key, o.key, ($event.target as HTMLInputElement).checked)"
            />
            {{ o.label }}
          </label>
        </span>
      </div>
      <div class="row">
        <label>图片描述写入</label>
        <select :value="cfg.output[s.key].captionMode" @change="setEntryField(s.key, 'captionMode', ($event.target as HTMLSelectElement).value)">
          <option value="replace">替换引用</option>
          <option value="both">两者都有</option>
        </select>
      </div>
      <div class="row">
        <label>图片描述默认启用</label>
        <input type="checkbox" :checked="cfg.output[s.key].captionEnabled" @change="setEntryField(s.key, 'captionEnabled', ($event.target as HTMLInputElement).checked)" />
      </div>
      <div class="row">
        <label>完成后自动打开</label>
        <input type="checkbox" :checked="cfg.output[s.key].autoOpen" @change="setEntryField(s.key, 'autoOpen', ($event.target as HTMLInputElement).checked)" />
      </div>
      <div v-if="s.key === 'rightClick'" class="row">
        <label>进度窗自动关闭</label>
        <input type="checkbox" :checked="cfg.output.autoCloseProgress" @change="onPatch((c) => { c.output.autoCloseProgress = ($event.target as HTMLInputElement).checked; })" />
      </div>
      <p class="hint">Markdown 生成 full.md；JSON / 图片来自解析结果包可直接读取；DOCX / HTML 需服务端额外生成（略慢）。其中 DOCX 自带图片。启用图片描述、完成解析后，若没有勾选图片，则会自动删除全部图片。勾选「全部」即五项全选。</p>
    </section>
  </div>
</template>

<style scoped>
.grp-title { font-size: 15px; margin: 0 0 12px; }
.sect { border-top: 1px solid #ececec; padding: 10px 0 4px; }
.sect:first-of-type { border-top: none; padding-top: 0; }
.sect-title { font-size: 13px; font-weight: 600; color: var(--lu-primary, #0e8afe); margin: 4px 0 8px; }
.row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 13px; }
.row label { flex: 0 0 130px; color: #555; }
.row input:not([type="checkbox"]), .row select { flex: 1; min-width: 0; padding: 0.4em 0.6em; font-size: 13px; border: 1px solid #d4d4d4; border-radius: 8px; background: #fff; color: #0f0f0f; }
.checks { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; flex: 1; min-width: 0; }
.row .chk { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; color: inherit; cursor: pointer; }
.row .chk input { margin: 0; }
.hint { font-size: 12px; color: #999; margin: 6px 0 0; }
@media (prefers-color-scheme: dark) {
  .sect { border-top-color: #333; }
  .sect-title { color: #8fb0f0; }
  .row label { color: #aaa; }
  .row input, .row select { background: #2c2c2c; border-color: #444; color: #f6f6f6; }
  .hint { color: #999; }
}
</style>

<script setup lang="ts">
// 轮 G 日志重构（T2·T5）：底部用户通知流面板。
// 与调试日志（LogViewer 黑盒）分离——这里只展示「用户需要知道/需要操作」的通知，无技术黑话。
// 特性：折叠（默认 3 行）/展开、详细/简略切换、未读计数 N、清空、每条可复制（不预览复杂日志，跳转一律打开文件夹）。
// 数据来自 core/platform/user-feed（内存单例，主窗口关闭即销毁，不落盘）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getUserFeed, onUserFeed, unreadCount, markAllRead, clearUserFeed, type FeedEntry } from "../core/platform/user-feed";
import type { UserAction } from "../core/platform/user-messages";
import Icon from "./components/Icon.vue";

const emit = defineEmits<{
  (e: "open-debug"): void;
  (e: "navigate", group: string): void;
  (e: "action", payload: UserAction): void;
}>();

const entries = ref<FeedEntry[]>([]);
const expanded = ref(false);
const detailed = ref(false);
const unread = ref(0);
const copiedId = ref<string | null>(null);

let off: (() => void) | null = null;
function refresh(): void {
  entries.value = getUserFeed();
  unread.value = unreadCount();
}

onMounted(() => {
  refresh();
  off = onUserFeed(refresh);
});
onBeforeUnmount(() => {
  if (off) off();
});

// 展开即标记全部已读（未读徽标代表「自上次查看以来的新通知」）
watch(expanded, (v) => {
  if (v) markAllRead();
});

const shown = computed(() => (expanded.value ? entries.value : entries.value.slice(0, 3)));

function onClear(): void {
  clearUserFeed();
}

// 复制单条通知（标题 + 详情）到剪贴板，便于把错误原文贴给排查/反馈
async function copyEntry(e: FeedEntry): Promise<void> {
  const text = e.detail ? `${e.title}\n${e.detail}` : e.title;
  try {
    await navigator.clipboard.writeText(text);
    copiedId.value = e.id;
    window.setTimeout(() => {
      if (copiedId.value === e.id) copiedId.value = null;
    }, 1500);
  } catch {
    // 非安全上下文等剪贴板不可用时静默；如需强提示可由调用方改用通知
  }
}

function levelClass(e: FeedEntry): string {
  return `lvl-${e.level}`;
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function onAction(a?: UserAction): void {
  if (!a) return;
  if (a.kind === "navigate") {
    // 兜底跳到 MinerU（原 general 组已并入「输出」二级页签，不再作为顶栏分组）
    emit("navigate", a.target ?? "mineru");
  } else if (a.kind === "open-log") {
    emit("open-debug");
  } else {
    emit("action", a);
  }
}
</script>

<template>
  <div class="np" :class="{ expanded }">
    <div class="np-head">
      <div class="np-left">
        <button class="np-icon" :disabled="entries.length === 0" title="清空通知" @click="onClear">
          <Icon name="trash" :size="15" />
        </button>
        <div class="np-title">
          通知
          <span v-if="unread > 0" class="np-badge">{{ unread }}</span>
        </div>
      </div>
      <div class="np-tools">
        <button class="np-btn" @click="detailed = !detailed">{{ detailed ? "简略" : "详细" }}</button>
        <button class="np-btn icon" :title="expanded ? '收起' : '展开'" @click="expanded = !expanded">
          <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" :size="16" />
        </button>
      </div>
    </div>
    <div class="np-body">
      <p v-if="entries.length === 0" class="np-empty">暂无通知（解析进度、完成、错误与需要你操作的提示会显示在这里）</p>
      <div v-for="e in shown" :key="e.id" class="np-item" :class="levelClass(e)">
        <span class="np-dot" />
        <div class="np-text">
          <div class="np-line">
            <span class="np-msg">{{ e.title }}</span>
            <span class="np-time">{{ fmtTime(e.at) }}</span>
          </div>
          <div v-if="detailed && e.detail" class="np-detail">{{ e.detail }}</div>
        </div>
        <button class="np-copy" @click="copyEntry(e)">{{ copiedId === e.id ? "已复制" : "复制" }}</button>
        <button v-if="e.action" class="np-act" @click="onAction(e.action)">{{ e.action.label }}</button>
      </div>
      <p v-if="!expanded && entries.length > 3" class="np-more">还有 {{ entries.length - 3 }} 条，点击「展开」查看</p>
    </div>
  </div>
</template>

<style scoped>
.np {
  flex: 0 0 auto;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.np-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid #f1f3f5;
  flex-shrink: 0;
}
.np-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.np-icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  padding: 0;
}
.np-icon:hover {
  border-color: var(--lu-danger, #f04f75);
  color: var(--lu-danger, #f04f75);
}
.np-icon:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.np-title {
  font-size: 13px;
  font-weight: 600;
  color: #444;
  display: flex;
  align-items: center;
  gap: 6px;
}
.np-badge {
  background: var(--lu-danger, #f04f75);
  color: #fff;
  border-radius: 10px;
  font-size: 11px;
  padding: 0 6px;
  line-height: 18px;
  min-width: 18px;
  text-align: center;
}
.np-tools {
  display: flex;
  gap: 6px;
}
.np-btn {
  border: 1px solid #d4d4d4;
  background: #fff;
  border-radius: 7px;
  padding: 0.25em 0.6em;
  font-size: 12px;
  cursor: pointer;
  color: #333;
}
.np-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.np-btn.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.2em 0.45em;
}
.np-btn.primary {
  background: var(--lu-primary, #0e8afe);
  border-color: var(--lu-primary, #0e8afe);
  color: #fff;
}
.np-body {
  overflow-y: auto;
  max-height: 92px;
  padding: 4px 12px 8px;
}
.np.expanded .np-body {
  max-height: 38vh;
}
.np-empty {
  font-size: 12px;
  color: #999;
  margin: 6px 0;
}
.np-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  border-bottom: 1px solid #f0f0f0;
}
.np-item:last-child {
  border-bottom: none;
}
.np-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
  background: #888;
}
.lvl-info .np-dot {
  background: var(--lu-primary, #0e8afe);
}
.lvl-success .np-dot {
  background: var(--lu-success-ink, #009e80);
}
.lvl-warn .np-dot {
  background: var(--lu-warning, #f7903d);
}
.lvl-error .np-dot {
  background: var(--lu-danger, #f04f75);
}
.np-text {
  flex: 1;
  min-width: 0;
}
.np-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.np-msg {
  flex: 1;
  min-width: 0;
  color: #1a1a1a;
  word-break: break-word;
}
.lvl-warn .np-msg {
  color: var(--lu-warning, #f7903d);
}
.lvl-error .np-msg {
  color: #991b1b;
}
.np-time {
  flex-shrink: 0;
  font-size: 11px;
  color: #aaa;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.np-detail {
  font-size: 12px;
  color: #666;
  margin-top: 2px;
  word-break: break-word;
  white-space: pre-wrap;
}
.np-copy {
  flex-shrink: 0;
  border: 1px solid #d4d4d4;
  background: #fff;
  color: #666;
  border-radius: 7px;
  padding: 0.2em 0.6em;
  font-size: 12px;
  cursor: pointer;
}
.np-act {
  flex-shrink: 0;
  border: 1px solid var(--lu-primary, #0e8afe);
  background: #fff;
  color: var(--lu-primary, #0e8afe);
  border-radius: 7px;
  padding: 0.2em 0.6em;
  font-size: 12px;
  cursor: pointer;
}
.np-more {
  font-size: 11px;
  color: #999;
  margin: 4px 0 0;
}
@media (prefers-color-scheme: dark) {
  .np {
    background: #1f1f1f;
    border-color: #3a3a3a;
  }
  .np-head {
    border-bottom-color: #2c2c2c;
  }
  .np-icon {
    background: #2c2c2c;
    border-color: #444;
    color: #cbd5e1;
  }
  .np-title {
    color: #ddd;
  }
  .np-btn {
    background: #2c2c2c;
    border-color: #444;
    color: #f6f6f6;
  }
  .np-btn.primary {
    background: var(--lu-primary, #0e8afe);
    border-color: var(--lu-primary, #0e8afe);
    color: #fff;
  }
  .np-msg {
    color: #e8e8e8;
  }
  .lvl-warn .np-msg {
    color: #fbbf24;
  }
  .lvl-error .np-msg {
    color: #f87171;
  }
  .np-detail {
    color: #aaa;
  }
  .np-copy {
    background: #2c2c2c;
    border-color: #444;
    color: #bbb;
  }
  .np-act {
    background: #2c2c2c;
    border-color: #5b8def;
    color: #8fb0f0;
  }
}
</style>

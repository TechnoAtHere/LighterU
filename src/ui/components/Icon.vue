<script setup lang="ts">
// 统一图标组件（lucide 线性图标，ISC License，见 NOTICE）。
// 用法：<Icon name="play" :size="16" />；颜色继承 currentColor，便于主题化。
withDefaults(
  defineProps<{
    name:
      | "chevron-down"
      | "chevron-left"
      | "chevron-right"
      | "chevron-up"
      | "chevrons-left-right"
      | "corner-up-left"
      | "pause"
      | "play"
      | "refresh-ccw"
      | "repeat"
      | "rotate-ccw"
      | "settings"
      | "square-arrow-out-up-right"
      | "trash";
    size?: number;
    strokeWidth?: number;
  }>(),
  { size: 16, strokeWidth: 2 },
);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'chevron-down'"><path d="m6 9 6 6 6-6" /></template>
    <template v-else-if="name === 'chevron-left'"><path d="m15 18-6-6 6-6" /></template>
    <template v-else-if="name === 'chevron-right'"><path d="m9 18 6-6-6-6" /></template>
    <template v-else-if="name === 'chevron-up'"><path d="m18 15-6-6-6 6" /></template>
    <template v-else-if="name === 'chevrons-left-right'">
      <path d="m9 7-5 5 5 5" /><path d="m15 7 5 5-5 5" />
    </template>
    <template v-else-if="name === 'corner-up-left'">
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" /><path d="M9 14 4 9l5-5" />
    </template>
    <template v-else-if="name === 'pause'">
      <rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" />
    </template>
    <template v-else-if="name === 'play'">
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    </template>
    <template v-else-if="name === 'refresh-ccw'">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" />
    </template>
    <template v-else-if="name === 'repeat'">
      <path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </template>
    <template v-else-if="name === 'rotate-ccw'">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
    </template>
    <template v-else-if="name === 'settings'">
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" />
    </template>
    <template v-else-if="name === 'square-arrow-out-up-right'">
      <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
      <path d="m21 3-9 9" />
      <path d="M15 3h6v6" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </template>
  </svg>
</template>

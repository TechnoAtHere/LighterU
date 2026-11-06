import { createApp } from "vue";
import "./global.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./core/platform/env";
import App from "./App.vue";
import ParseDialog from "./ui/parse-dialog/ParseDialog.vue";
import Progress from "./ui/progress/Progress.vue";

// 多窗口路由（T4-11/T4-06 / 轮 G）：
// 1) 显式 ?window=<kind> 优先（dev 诊断 / headless 入口仍走 query）；
// 2) 否则按窗口 label 路由——动态创建的 progress-N / 预定义 parse-dialog 一定可靠，
//    不依赖 WebviewUrl 拼接 query 是否被正确保留，避免「空白界面」。
function resolveWindowKind(): string | null {
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const q = params.get("window");
  if (q) return q;
  if (isTauri()) {
    try {
      const label = getCurrentWindow().label;
      if (label.startsWith("progress")) return "progress";
      if (label === "parse-dialog") return "parse-dialog";
    } catch {
      // 忽略，回退到 query / main
    }
  }
  return null;
}
const windowKind = resolveWindowKind();
const Root = windowKind === "parse-dialog" ? ParseDialog : windowKind === "progress" ? Progress : App;

// dev-only 诊断与无头入口（D-24）：仅开发模式加载；生产构建中 process.env.NODE_ENV 被静态替换，
// 条件为假，动态 import 被树摇移除（不进生产构建）。
if (process.env.NODE_ENV !== "production") {
  void import("./dev/diag").then(async ({ diag, installDiagHooks }) => {
    installDiagHooks();
    await diag(`boot: main.ts mounted, window=${windowKind ?? "main"}, url=${typeof location !== "undefined" ? location.href : "n/a"}`);
  });
}

createApp(Root).mount("#app");

// dev-only 无头入口（D-24）：仅主工作站窗口；URL 带 ?headless=1&file=<pdf路径> 时自动跑全链。
const headlessParams = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
if (
  process.env.NODE_ENV !== "production" &&
  windowKind === null &&
  typeof location !== "undefined" &&
  location.search.includes("headless=1")
) {
  void import("./dev/headless").then(async ({ runHeadless }) => {
    const file = headlessParams.get("file") ?? "";
    const result = await runHeadless({
      filePath: file,
      log: (line) => console.log(`[headless] ${line}`),
    });
    console.log(`[headless] 结束 status=${result.status} outputDir=${result.outputDir} error=${result.error ?? ""}`);
  });
}

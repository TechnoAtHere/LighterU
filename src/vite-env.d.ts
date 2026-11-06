/// <reference types="vite/client" />

/** 构建期由 vite.config.ts 的 define 注入（D-93）；Node 环境下未定义，读取前需 typeof 守卫 */
declare const __LU_VERSION__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

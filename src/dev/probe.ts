// dev-only · 插件自检 + T1-03 WebView 双路取证（D-24，不进生产构建）
// 运行：npm run tauri dev 后访问 http://localhost:1420/?probe=1
// 每条结果即时写入 <AppConfigDir>/lu-diag.log（增量，防挂起丢失证据）。

import { diag } from './diag'

export async function runPluginProbes(log: (line: string) => void): Promise<void> {
  const out = async (line: string): Promise<void> => {
    log(line)
    await diag(`probe: ${line}`)
  }
  await out('开始插件自检')

  // ---- fs 插件（AppLog 目录内写/读/删；安全模型只授权 $APPLOG）
  try {
    const { writeTextFile, readTextFile, remove, BaseDirectory } = await import("@tauri-apps/plugin-fs")
    await writeTextFile("lu-probe.txt", "ok", { baseDir: BaseDirectory.AppLog })
    const back = await readTextFile("lu-probe.txt", { baseDir: BaseDirectory.AppLog })
    await remove("lu-probe.txt", { baseDir: BaseDirectory.AppLog })
    await out(`fs: OK（AppLog 写/读/删，read=${back}）`)
  } catch (err) {
    await out(`fs: FAIL ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- sql 插件（内存库 SELECT 1）
  try {
    const Database = (await import("@tauri-apps/plugin-sql")).default
    const db = await Database.load("sqlite:lu-probe.db")
    const rows = await db.select<Array<{ ok: number }>>("SELECT 1 AS ok")
    await db.close()
    await out(`sql: OK ${JSON.stringify(rows)}`)
  } catch (err) {
    await out(`sql: FAIL ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- store 插件（set/save/get）
  try {
    const { Store } = await import("@tauri-apps/plugin-store")
    const store = await Store.load("lu-probe.json")
    await store.set("probe", "ok")
    await store.save()
    const value = await store.get("probe")
    await out(`store: OK（get=${String(value)}）`)
  } catch (err) {
    await out(`store: FAIL ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- http 双路取证：WebView fetch vs plugin-http 打 mineru.net（无 token，预期 401 / CORS 拦截）
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    const resp = await fetch("https://mineru.net/api/v4/extract-results/batch/probe-nonexistent", {
      method: "GET",
      signal: controller.signal,
    })
    clearTimeout(timer)
    await out(`http-fetch(WebView): status=${resp.status} type=${resp.type}`)
  } catch (err) {
    const e = err as { name?: string; message?: string }
    await out(`http-fetch(WebView): BLOCKED/FAIL ${e.name ?? "Error"}: ${e.message ?? ""}`)
  }
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    const resp = await tauriFetch("https://mineru.net/api/v4/extract-results/batch/probe-nonexistent", {
      method: "GET",
      signal: controller.signal,
    })
    clearTimeout(timer)
    await out(`http-plugin-http: status=${resp.status}`)
  } catch (err) {
    await out(`http-plugin-http: FAIL ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- 自定义 Rust 命令冒烟（lu_ensure_dir + lu_exists）
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const { appConfigDir, join } = await import("@tauri-apps/api/path")
    const dir = await appConfigDir()
    const probeDir = await join(dir, "lu-probe-dir")
    await invoke("lu_ensure_dir", { path: probeDir })
    const exists = await invoke<boolean>("lu_exists", { path: probeDir })
    await out(`rust-commands: OK（ensure_dir+exists，目录存在=${exists}）`)
  } catch (err) {
    await out(`rust-commands: FAIL ${err instanceof Error ? err.message : String(err)}`)
  }

  await out('插件自检结束')
}

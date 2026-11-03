import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MarketPlugin, PluginEntry, PluginStats } from "./types";

const apiDir = join(process.cwd(), "public", "api", "v1");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(apiDir, file), "utf-8")) as T;
  } catch (error) {
    // `pnpm dev` / `pnpm build` 可在未运行 market:build 时启动，此时目录为空
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 索引里不含统计字段，展示前从 stats.json 补齐 */
export async function getPlugins(): Promise<MarketPlugin[]> {
  const entries = await readJson<PluginEntry[]>("plugins.json");
  if (entries === null) return [];
  const stats = (await readJson<Record<string, PluginStats>>("stats.json")) ?? {};
  return entries.map((entry) => ({
    ...entry,
    stars: stats[entry.id]?.stars ?? 0,
    downloads: stats[entry.id]?.downloads ?? 0
  }));
}

export async function getPlugin(id: string): Promise<MarketPlugin | undefined> {
  const plugins = await getPlugins();
  return plugins.find((plugin) => plugin.id === id);
}

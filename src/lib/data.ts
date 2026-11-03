import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginEntry } from "./types";

const pluginsFile = join(process.cwd(), "public", "api", "v1", "plugins.json");

export async function getPlugins(): Promise<PluginEntry[]> {
  try {
    return JSON.parse(await readFile(pluginsFile, "utf-8")) as PluginEntry[];
  } catch (error) {
    // `pnpm dev` / `pnpm build` 可在未运行 market:build 时启动，此时目录为空
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function getPlugin(id: string): Promise<PluginEntry | undefined> {
  const plugins = await getPlugins();
  return plugins.find((plugin) => plugin.id === id);
}

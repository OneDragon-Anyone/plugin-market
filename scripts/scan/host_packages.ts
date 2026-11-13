/**
 * 主程序自带包清单：从主程序仓库的 uv.lock 取全部发行名，换算成 import 名后给扫描器当白名单。
 *
 * 清单跟着主程序走，不在这里手抄。抓下来的结果落一份快照在 lock 目录，
 * 抓不到时沿用上一份，扫描结论因此可复现；只有清单真的变了才写盘，免得每轮 build 都产生提交。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** 主程序仓库与分支，插件跑在它的 Python 环境里 */
const HOST_REPOSITORY = "OneDragon-Anything/ZenlessZoneZero-OneDragon";
const HOST_REF = "main";
const LOCK_URL = `https://raw.githubusercontent.com/${HOST_REPOSITORY}/${HOST_REF}/uv.lock`;
const SNAPSHOT_NAME = "host-packages.json";
const MAX_LOCK_BYTES = 4 * 1024 * 1024;

/**
 * 发行名与 import 名对不上的包，其余按小写、分隔符归一（charset-normalizer → charset_normalizer）。
 * 这张表只在主程序换了包名时才会变；漏写只会多报一条待确认，不会漏报。
 */
const MODULE_OVERRIDES: Record<string, string[]> = {
  "opencv-python": ["cv2"],
  pyyaml: ["yaml"],
  pyside6: ["PySide6"],
  "pyside6-addons": ["PySide6"],
  "pyside6-essentials": ["PySide6"],
  "pyside6-fluent-widgets": ["qfluentwidgets"],
  pillow: ["PIL"],
  "onnxruntime-directml": ["onnxruntime"],
  "websocket-client": ["websocket"],
  protobuf: ["google"],
  "python-dateutil": ["dateutil"],
  pywin32: [
    "win32api", "win32con", "win32gui", "win32ui", "win32process", "win32com",
    "winerror", "pythoncom", "pywintypes"
  ]
};

interface Snapshot {
  source: string;
  modules: string[];
}

export function hostPackagesPath(lockDir: string): string {
  return join(lockDir, SNAPSHOT_NAME);
}

/** uv.lock 是 TOML，这里只取每个 [[package]] 的 name 行，不引 TOML 解析器 */
export function parseLockNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^name\s*=\s*"([^"]+)"$/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

/** 发行名换成 import 名，去重排序，保证同一份 uv.lock 每次算出的结果一致 */
export function toModules(distributions: string[]): string[] {
  const modules = new Set<string>();
  for (const name of distributions) {
    const overridden = MODULE_OVERRIDES[name.toLowerCase()];
    if (overridden) {
      for (const module of overridden) modules.add(module);
      continue;
    }
    modules.add(name.toLowerCase().replace(/[-_.]+/g, "_"));
  }
  return [...modules].sort();
}

async function fetchLock(): Promise<string> {
  const response = await fetch(LOCK_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${LOCK_URL} -> ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_LOCK_BYTES) throw new Error(`uv.lock is ${text.length} bytes, limit ${MAX_LOCK_BYTES}`);
  if (parseLockNames(text).length === 0) throw new Error("uv.lock has no package names");
  return text;
}

async function readSnapshot(lockDir: string): Promise<Snapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(hostPackagesPath(lockDir), "utf-8")) as Snapshot;
    return Array.isArray(parsed.modules) && parsed.modules.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSnapshot(lockDir: string, modules: string[]): Promise<void> {
  const snapshot: Snapshot = { source: `${HOST_REPOSITORY}@${HOST_REF}`, modules };
  await mkdir(lockDir, { recursive: true });
  await writeFile(hostPackagesPath(lockDir), `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

/**
 * 取主程序自带包的 import 名。优先用刚抓到的清单，抓不到退回上一次的快照，
 * 两者都没有就返回空数组——扫描照常跑，只是主程序自带的包会被当成第三方报出来。
 * fetchText 只为测试注入，正常调用用默认实现。
 */
export async function loadHostPackages(
  lockDir: string,
  log: (line: string) => void,
  fetchText: () => Promise<string> = fetchLock
): Promise<string[]> {
  const previous = await readSnapshot(lockDir);
  try {
    const modules = toModules(parseLockNames(await fetchText()));
    const changed = !previous || previous.modules.join("\n") !== modules.join("\n");
    if (changed) await writeSnapshot(lockDir, modules);
    return modules;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = previous ? "沿用上一份清单" : "本轮不把主程序自带的包列入白名单";
    log(`- ⚠️ 主程序依赖清单抓取失败，${fallback}：${message.slice(0, 160)}`);
    return previous?.modules ?? [];
  }
}

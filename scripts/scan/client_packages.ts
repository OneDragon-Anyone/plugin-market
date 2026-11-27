/**
 * 客户端自带包清单：从客户端仓库的依赖锁文件取全部发行名，换算成 import 名后给扫描器当白名单。
 *
 * 锁文件地址与自带模块根由调用方数据仓的 policy.json 给出，引擎里不写死任何具体客户端。
 * 清单跟着客户端走，不在这里手抄。抓下来的结果落一份快照在 lock 目录，抓不到时沿用上一份，
 * 扫描结论因此可复现；只有清单真的变了才写盘，免得每轮 build 都产生提交。
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ClientConfig } from "@/lib/config";
import { errorMessage } from "../lib/runtime";

const SNAPSHOT_NAME = "client-packages.json";
/** 改名前的快照文件，写新文件时顺手清掉，免得 lock 分支里留一份永不更新的旧清单 */
const LEGACY_SNAPSHOT_NAME = "host-packages.json";
const MAX_LOCK_BYTES = 4 * 1024 * 1024;

/**
 * 发行名与 import 名对不上的包，其余按小写、分隔符归一（charset-normalizer → charset_normalizer）。
 * 这张表是通用的 Python 生态知识，跟具体客户端无关；漏写只会多报一条第三方 import，不会漏报。
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

export function clientPackagesPath(lockDir: string): string {
  return join(lockDir, SNAPSHOT_NAME);
}

/** 锁文件名只用在提示里，从地址末段取 */
function fileNameOf(url: string): string {
  return url.split("/").pop() || "锁文件";
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

/** 发行名换成 import 名，去重排序，保证同一份锁文件每次算出的结果一致 */
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

async function fetchLock(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_LOCK_BYTES) throw new Error(`${fileNameOf(url)} is ${text.length} bytes, limit ${MAX_LOCK_BYTES}`);
  if (parseLockNames(text).length === 0) throw new Error(`${fileNameOf(url)} has no package names`);
  return text;
}

async function readSnapshot(lockDir: string, source: string): Promise<Snapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(clientPackagesPath(lockDir), "utf-8")) as Snapshot;
    if (parsed.source !== source) return null;
    return Array.isArray(parsed.modules) && parsed.modules.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSnapshot(lockDir: string, source: string, modules: string[]): Promise<void> {
  const snapshot: Snapshot = { source, modules };
  await mkdir(lockDir, { recursive: true });
  await writeFile(clientPackagesPath(lockDir), `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  await rm(join(lockDir, LEGACY_SNAPSHOT_NAME), { force: true });
}

export interface ClientPackages {
  /** 白名单：锁文件里的包名 + 客户端模块根 */
  modules: string[];
  /**
   * 是否拿到了可用的清单。抓不到又没快照时为 false，调用方据此跳过依赖扫描——
   * 只拿几个模块根去比，会把客户端自带的包全报成第三方，结论没有意义。
   */
  fromLock: boolean;
}

/**
 * 取客户端自带包的 import 名，连同数据仓声明的客户端模块根一起当作白名单。
 * 优先用刚抓到的清单，抓不到退回上一次的快照；两者都没有就返回模块根并把
 * fromLock 置为 false，由调用方决定要不要跑依赖扫描。fetchText 只为测试注入。
 */
export async function loadClientPackages(
  client: ClientConfig,
  lockDir: string,
  log: (line: string) => void,
  fetchText: () => Promise<string> = () => fetchLock(client.lockUrl)
): Promise<ClientPackages> {
  const roots = client.moduleRoots;
  const previous = await readSnapshot(lockDir, client.lockUrl);
  try {
    const modules = toModules(parseLockNames(await fetchText()));
    const merged = [...new Set([...modules, ...roots])].sort();
    const changed = !previous || previous.modules.join("\n") !== merged.join("\n");
    if (changed) await writeSnapshot(lockDir, client.lockUrl, merged);
    return { modules: merged, fromLock: true };
  } catch (error) {
    if (previous) {
      log(`- ⚠️ 客户端依赖清单抓取失败，沿用上一份：${errorMessage(error).slice(0, 160)}`);
      return { modules: previous.modules, fromLock: true };
    }
    log(`- ⚠️ 客户端依赖清单抓取失败，且没有可用的快照，本轮不跑依赖扫描：${errorMessage(error).slice(0, 160)}`);
    return { modules: roots, fromLock: false };
  }
}

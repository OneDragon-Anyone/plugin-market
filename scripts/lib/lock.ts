/** 构建状态：路径、锁文件结构、扫描缓存与一次构建的共享上下文。 */

import { ScanCache, scanCachePath } from "../scan/client";
import { rootDir } from "./market";
import { type MarketPolicy, type PluginEntry, type PluginStats, type WarningCode } from "@/lib/types";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// ---- 共享状态与锁文件结构 ----

/** 构建产物：条目 + 每轮都会变的统计值，写盘时分开存 */
export type BuiltPlugin = PluginEntry & PluginStats;

/** 一次构建的共享状态：原先散在入口顶层的常量集中到这里 */
export interface BuildContext {
  now: Date;
  report: string[];
  policy: MarketPolicy;
  lock: Lock;
  lockDir: string;
  lockPath: string;
  lockCoversDir: string;
  apiDir: string;
  previousApiUrl: string;
  templateDir: string;
  issueTarget: string;
  scanCache: ScanCache;
  /** 本轮已补扫的存量版本数，每轮限量 */
  backfillScans: number;
  /** 市场上已收录的插件 id，读完条目后填；插件之间互相 import 不算第三方依赖 */
  knownPlugins: string[];
  /** 主程序环境里已经装好的 import 名，启动时从主程序的 uv.lock 取 */
  hostPackages: string[];
  /** 上一版 stats.json 只拉一次，null 表示还没读 */
  previousStatsCache: Record<string, PluginStats> | null;
}

export function lockDirectories(): { lockDir: string; lockPath: string; lockCoversDir: string } {
  const lockDir = resolve(process.env.LOCK_DIR ?? join(rootDir, ".lock"));
  return {
    lockDir,
    lockPath: join(lockDir, "sources.lock.json"),
    lockCoversDir: join(lockDir, "covers")
  };
}

export async function readLock(lockPath: string): Promise<Lock> {
  return existsSync(lockPath) ? (JSON.parse(await readFile(lockPath, "utf-8")) as Lock) : {};
}

export function createBuildContext(
  policy: MarketPolicy,
  lock: Lock,
  hostPackages: string[] = []
): BuildContext {
  const { lockDir, lockPath, lockCoversDir } = lockDirectories();
  const previousApiBase = (process.env.PREVIOUS_API_URL ?? "").trim();
  return {
    now: new Date(),
    report: [],
    policy,
    lock,
    lockDir,
    lockPath,
    lockCoversDir,
    apiDir: join(rootDir, "public", "api", "v1"),
    /** 统一补上结尾斜杠 相对地址才能正确拼到上一版目录下 */
    previousApiUrl: previousApiBase === "" ? "" : `${previousApiBase.replace(/\/+$/, "")}/`,
    /** 模板仓检出目录 与 validator 用的是同一个环境变量 */
    templateDir: resolve(process.env.TEMPLATE_DIR ?? ".plugin-template"),
    /** 自动 issue 要写进去的仓库 空串表示这轮不发（本地跑默认不发） */
    issueTarget:
      process.env.MARKET_OPEN_ISSUES === "true" ? (process.env.GITHUB_REPOSITORY ?? "").trim() : "",
    scanCache: new ScanCache(scanCachePath(lockDir)),
    backfillScans: 0,
    knownPlugins: [],
    hostPackages,
    previousStatsCache: null
  };
}

/** 已收录版本在 lock 里的记录 */
export interface LockRelease {
  version: string;
  versionCode: number;
  commit: string;
  assetId: number;
  assetName: string;
  size: number;
  sha256: string;
  verifiedAt: string;
  hasAppSetting: boolean;
  cover: string;
  manifest: Record<string, unknown>;
  /** 附件内容与收录记录不一致 或附件被删除 该版本不再发布 记录保留 免得被当成新版本重新收录 */
  revokedAt?: string;
  revokedReason?: "asset_changed" | "missing_asset";
}

/** 校验没通过 记下当时那个附件 同一个附件不再重复下载校验 */
export interface LockRejection {
  assetId: number;
  code: WarningCode;
  message: string;
}

export interface LockPlugin {
  repoId: number;
  repo: string;
  maxVersionCode: number;
  releases: Record<string, LockRelease>;
  rejected: Record<string, LockRejection>;
  unreachableSince?: string;
  staleIssue?: number;
  /** 下架通知发过的那条 issue 后续新下架的版本以评论追加 */
  revokedIssue?: number;
  /** 已经写进 issue 的版本 避免每次构建重复通知 */
  revokedNotified?: string[];
  /** 附件删掉、issue 关掉之后记下的记号 免得每轮重复关 */
  revokedResolved?: string;
  /** 安全扫描待确认项的那条 issue 后续新命中以评论追加 */
  securityIssue?: number;
  /** 已经写进 issue 的包 sha256 免得同一个包重复通知 */
  securityNotified?: string[];
}

export type Lock = Record<string, LockPlugin>;

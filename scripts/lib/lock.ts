/** 构建状态：锁文件结构，以及一次构建共享的上下文。 */

import { apiDir, lockCoversDir, lockPath, templateDir } from "./paths";
import { type MarketPolicy, type PluginEntry, type PluginStats, type WarningCode } from "@/lib/types";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// ---- 共享状态与锁文件结构 ----

/** 构建产物：条目 + 每轮都会变的统计值，写盘时分开存 */
export type BuiltPlugin = PluginEntry & PluginStats;

/** 一次构建的共享状态：原先散在入口顶层的常量集中到这里 */
export interface BuildContext {
  now: Date;
  report: string[];
  policy: MarketPolicy;
  lock: Lock;
  lockPath: string;
  lockCoversDir: string;
  apiDir: string;
  previousApiUrl: string;
  templateDir: string;
  issueTarget: string;
  /** 上一版 stats.json 只拉一次，null 表示还没读 */
  previousStatsCache: Record<string, PluginStats> | null;
}

export async function readLock(): Promise<Lock> {
  return existsSync(lockPath) ? (JSON.parse(await readFile(lockPath, "utf-8")) as Lock) : {};
}

export function createBuildContext(policy: MarketPolicy, lock: Lock): BuildContext {
  const previousApiBase = (process.env.PREVIOUS_API_URL ?? "").trim();
  return {
    now: new Date(),
    report: [],
    policy,
    lock,
    lockPath,
    lockCoversDir,
    apiDir,
    /** 统一补上结尾斜杠 相对地址才能正确拼到上一版目录下 */
    previousApiUrl: previousApiBase === "" ? "" : `${previousApiBase.replace(/\/+$/, "")}/`,
    templateDir,
    /** 自动 issue 要写进去的仓库 空串表示这轮不发（本地跑默认不发） */
    issueTarget:
      process.env.MARKET_OPEN_ISSUES === "true" ? (process.env.GITHUB_REPOSITORY ?? "").trim() : "",
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
}

export type Lock = Record<string, LockPlugin>;

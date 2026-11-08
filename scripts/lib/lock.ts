import type { WarningCode } from "@/lib/types";

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
  /** 开通知时市场已收录的最大内部版本号 只有比它还大的才算作者补发 用来关 issue */
  revokedFloor?: number;
  /** 作者补发新版本后自动关闭的那条通知 记下当时的 tag 免得反复关 */
  revokedResolved?: string;
}

export type Lock = Record<string, LockPlugin>;

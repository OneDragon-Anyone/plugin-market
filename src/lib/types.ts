export type MarketStatus = "listed" | "hidden" | "deprecated" | "suspended" | "removed";

export const RISK_TAGS = [
  "filesystem",
  "network",
  "account",
  "automation",
  "ocr",
  "yolo",
  "clipboard",
  "process"
] as const;

export type RiskTag = (typeof RISK_TAGS)[number];

export type WarningCode =
  | "version_not_increased"
  | "asset_changed"
  | "id_mismatch"
  | "missing_asset"
  | "invalid_package"
  | "repo_identity_changed"
  | "repo_unreachable"
  | "mirror_failed";

export interface PluginWarning {
  code: WarningCode;
  message: string;
  version?: string;
}

export interface PluginAuthor {
  name: string;
  url: string;
}

export interface PluginRelease {
  version: string;
  versionCode: number;
  tag: string;
  commit: string;
  prerelease: boolean;
  immutable: boolean;
  publishedAt: string;
  changelogHtml: string;
  downloadUrl: string;
  /** 每个下载源各一份地址，键与资源下载源 ID 一致（github / cnb）。 */
  sources?: Record<string, string>;
  assetName: string;
  size: number;
  sha256: string;
}

export interface PluginCompatibility {
  minAppVersion: string;
  minCoreApiVersion: number;
  python: string;
}

export interface PluginCapabilities {
  hasAppSetting: boolean;
  defaultGroup: boolean;
  needNotify: boolean;
}

export interface PluginEntry {
  id: string;
  name: string;
  summary: string;
  repo: string;
  repoId: number;
  author: PluginAuthor;
  cover: string;
  stars: number;
  downloads: number;
  stale: boolean;
  readmeHtml: string;
  tags: string[];
  risk: RiskTag[];
  status: Exclude<MarketStatus, "removed">;
  pinned: boolean;
  warnings: PluginWarning[];
  compatibility: PluginCompatibility;
  capabilities: PluginCapabilities;
  latest: PluginRelease | null;
  latestBeta: PluginRelease | null;
  releases: PluginRelease[];
  updatedAt: string;
}

export interface MarketIndex {
  schemaVersion: 1;
  generatedAt: string;
  buildId: string;
  pluginCount: number;
}

export interface SearchEntry {
  id: string;
  name: string;
  summary: string;
  author: string;
  tags: string[];
  risk: RiskTag[];
}

export interface MarketSourceEntry {
  id: string;
  repo: string;
  repoId: number;
  tags: string[];
  extraRisk?: RiskTag[];
  status: MarketStatus;
  pinned?: boolean;
  review: {
    issue?: number;
    pr?: number;
    submittedBy: string;
  };
}

export interface MarketMirrorPolicy {
  /** 是否启用国内下载源镜像 */
  enabled: boolean;
  /** 镜像附件存放的仓库 格式 组织名称/仓库名称 */
  repo?: string;
  /** CNB OpenAPI 地址 默认 https://api.cnb.cool */
  api?: string;
  /** 创建 tag 时指向的分支 默认 main */
  branch?: string;
  /** 镜像 tag 的前缀 默认直接以插件 id 作为 tag */
  tagPrefix?: string;
  /** 每个插件保留多少个历史版本的镜像 默认使用 keepReleases */
  keepReleases?: number;
}

export interface MarketPolicy {
  reservedIds: string[];
  bannedRepoIds: number[];
  bannedUsers: string[];
  maxZipBytes: number;
  maxCoverBytes: number;
  keepReleases: number;
  repoUnreachableDays: number;
  rateLimit: {
    maxOpenSubmissionsPerUser: number;
    windowHours: number;
  };
  /** 国内下载源镜像配置 未配置或关闭时行为与改造前一致 */
  mirror?: MarketMirrorPolicy;
}

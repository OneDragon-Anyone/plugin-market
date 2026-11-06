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
  | "repo_unreachable";

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
  /** 每个下载源各一份地址，键与客户端资源下载源 ID 一致；github 恒为作者仓库原址。 */
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

/** 每次构建都会变的统计值 单独托管 不混在插件元数据里 */
export interface PluginStats {
  stars: number;
  downloads: number;
}

/** 网页展示用条目：索引本身不含统计字段 展示前由 stats.json 补齐 */
export interface MarketPlugin extends PluginEntry, PluginStats {}

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
  /**
   * 作者自建的镜像仓库，一个或两个（cnb + gitee），也只收这两家。
   *
   * 只填仓库地址本身，例如 `https://cnb.cool/组名/仓库名`、`https://gitee.com/用户名/仓库名`；
   * 两个用数组，一个直接写字符串。下载路径由构建按域名拼好，发新版不用回来改。
   * 镜像里的 tag 与附件名要和 GitHub 一致。
   */
  mirror?: string | string[];
  review: {
    issue?: number;
    pr?: number;
    submittedBy: string;
  };
}

/** 索引与封面的镜像目标 */
export interface MarketIndexMirror {
  /** 同步到的仓库 格式 组织名称/仓库名称 */
  repo?: string;
  /** 提交到的分支 默认 main */
  branch?: string;
}

/**
 * 镜像配置：市场只镜像自己产出的索引与封面。
 *
 * 未配置时索引只发布在 GitHub Pages；插件包始终由作者仓库分发，不经过市场。
 */
export interface MarketMirrorPolicy {
  /** 镜像开关：写 false 时整段跳过，不配置视为开启 */
  enabled?: boolean;
  /** CNB OpenAPI 地址 默认 https://api.cnb.cool */
  api?: string;
  /** 索引与封面镜像 */
  index?: MarketIndexMirror;
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
  /** 镜像配置 未配置时不做镜像 */
  mirror?: MarketMirrorPolicy;
}

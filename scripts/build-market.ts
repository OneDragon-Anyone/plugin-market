import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  PluginCompatibility,
  PluginEntry,
  PluginRelease,
  PluginStats,
  PluginWarning,
  MarketIndex,
  MarketPolicy,
  MarketSourceEntry,
  RiskTag,
  SearchEntry,
  WarningCode
} from "../src/lib/types";
import { type GhRelease, type GhRepo, github, githubText, listReleases, orNull, resolveTagCommit } from "./lib/github";
import { renderSafeHtml } from "./lib/html";
import {
  packageVersion,
  publishIndexFile,
  publishMirrorPackage,
  readMirrorTarget,
  readPackageDownloads,
  readPackageFiles,
  type PackageFile
} from "./lib/cnb";
import { checkEntries, readEntryFiles, readPolicy, rootDir } from "./lib/market";
import { downloadAndValidate } from "./lib/validator";

interface LockRelease {
  version: string;
  versionCode: number;
  commit: string;
  assetId: number;
  assetName: string;
  size: number;
  sha256: string;
  /** 国内下载源的镜像地址 缺失时对外回落到 GitHub 原地址 */
  mirrorUrl?: string;
  verifiedAt: string;
  hasAppSetting: boolean;
  cover: string;
  manifest: Record<string, unknown>;
}

interface LockRejection {
  assetId: number;
  code: WarningCode;
  message: string;
}

interface LockPlugin {
  repoId: number;
  repo: string;
  maxVersionCode: number;
  releases: Record<string, LockRelease>;
  rejected: Record<string, LockRejection>;
  unreachableSince?: string;
  staleIssue?: number;
  /** 上一次读到的制品库下载总量 读不到时沿用它免得数字回落 */
  cnbDownloads?: number;
}

type Lock = Record<string, LockPlugin>;

/** 构建过程中的条目 统计字段写盘时单独存进 stats.json */
type BuiltPlugin = PluginEntry & PluginStats;

const lockDir = resolve(process.env.LOCK_DIR ?? join(rootDir, ".lock"));
const lockPath = join(lockDir, "sources.lock.json");
const lockCoversDir = join(lockDir, "covers");
const apiDir = join(rootDir, "public", "api", "v1");
const previousApiBase = (process.env.PREVIOUS_API_URL ?? "").trim();
/** 统一补上结尾斜杠 相对地址才能正确拼到上一版目录下 */
const previousApiUrl = previousApiBase === "" ? "" : `${previousApiBase.replace(/\/+$/, "")}/`;
const now = new Date();
const report: string[] = [];
const mirrorFailures: { id: string; version: string; message: string }[] = [];

async function readLock(): Promise<Lock> {
  return existsSync(lockPath) ? (JSON.parse(await readFile(lockPath, "utf-8")) as Lock) : {};
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function freshLock(entry: MarketSourceEntry): LockPlugin {
  return { repoId: entry.repoId, repo: entry.repo, maxVersionCode: 0, releases: {}, rejected: {} };
}

function publishedAt(release: GhRelease): string {
  return release.published_at ?? release.created_at;
}

let cachedPreviousStats: Record<string, PluginStats> | null = null;

/** 上一次构建的统计值 读一次就缓存 还没有 stats.json 时按空表处理 */
async function previousStats(): Promise<Record<string, PluginStats>> {
  if (cachedPreviousStats !== null) return cachedPreviousStats;
  let loaded: Record<string, PluginStats> = {};
  if (previousApiUrl) {
    try {
      const response = await fetch(new URL("stats.json", previousApiUrl));
      if (response.ok) loaded = ((await response.json()) as Record<string, PluginStats>) ?? {};
    } catch {
      // 读不到按空表处理 统计值退回上一次构建的记录
    }
  }
  cachedPreviousStats = loaded;
  return loaded;
}

/** 沿用上一次构建的统计值 免得同步失败的插件被清零 */
async function previousStatsFor(id: string, known: Partial<PluginStats>): Promise<PluginStats> {
  return (await previousStats())[id] ?? { stars: known.stars ?? 0, downloads: known.downloads ?? 0 };
}

/** 上一次构建写出的条目 统计字段由 stats.json 单独提供 */
type PreviousEntry = PluginEntry & Partial<PluginStats>;

async function previousEntry(id: string): Promise<PreviousEntry | null> {
  if (!previousApiUrl) return null;
  try {
    const response = await fetch(new URL(`plugins/${id}.json`, previousApiUrl));
    return response.ok ? ((await response.json()) as PreviousEntry) : null;
  } catch {
    return null;
  }
}

/** 整条沿用上一次构建的结果 统计值以 stats.json 为准 */
async function carryOver(previous: PreviousEntry): Promise<BuiltPlugin> {
  const { stars, downloads, ...entry } = previous;
  return { ...entry, ...(await previousStatsFor(entry.id, { stars, downloads })) };
}

async function openStaleIssue(entry: MarketSourceEntry, days: number): Promise<number | undefined> {
  const marketRepo = process.env.GITHUB_REPOSITORY;
  if (!marketRepo || process.env.MARKET_OPEN_ISSUES !== "true") return undefined;
  const issue = await github<{ number: number }>(`/repos/${marketRepo}/issues`, {
    method: "POST",
    body: {
      title: `[stale] ${entry.id} 的仓库已连续 ${days} 天无法访问`,
      body: `插件 \`${entry.id}\`（repoId ${entry.repoId}，提交时为 \`${entry.repo}\`）的仓库已连续 ${days} 天无法访问，网站已标记为 stale。\n\n请维护者确认后决定是否将 \`status\` 改为 \`suspended\`。`
    }
  });
  return issue.number;
}

/** 镜像失败只会静默降级到 GitHub 原地址，开个 issue 提醒维护者。 */
async function openMirrorIssue(): Promise<void> {
  if (mirrorFailures.length === 0) return;
  const marketRepo = process.env.GITHUB_REPOSITORY;
  const detail = mirrorFailures.map((item) => `- \`${item.id}\` ${item.version}：${item.message}`);
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${marketRepo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  if (!marketRepo || process.env.MARKET_OPEN_ISSUES !== "true") return;
  try {
    // 定时构建每小时一次，未关闭的同名 issue 存在时不再重复开
    const query = encodeURIComponent(`repo:${marketRepo} is:issue is:open in:title "[mirror]"`);
    const existing = await github<{ total_count: number }>(
      `https://api.github.com/search/issues?q=${query}`
    );
    if (existing.total_count > 0) {
      report.push(`- ⚠️ 镜像失败 ${mirrorFailures.length} 个，已有未关闭的告警 issue`);
      return;
    }
    const issue = await github<{ number: number }>(`/repos/${marketRepo}/issues`, {
      method: "POST",
      body: {
        title: "[mirror] 安装包镜像上传失败",
        body: [
          "以下插件包没能传到国内镜像，对应版本的下载会退回 GitHub 原地址：",
          "",
          ...detail,
          "",
          `构建记录：${runUrl}`
        ].join("\n")
      }
    });
    report.push(`- ⚠️ 镜像失败 ${mirrorFailures.length} 个，已开 issue #${issue.number}`);
  } catch (error) {
    report.push(`- ⚠️ 镜像失败 ${mirrorFailures.length} 个，开 issue 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fallbackEntry(
  entry: MarketSourceEntry,
  lock: LockPlugin,
  policy: MarketPolicy,
  warning: PluginWarning
): Promise<BuiltPlugin | null> {
  lock.unreachableSince ??= now.toISOString();
  const days = (now.getTime() - new Date(lock.unreachableSince).getTime()) / 86_400_000;
  const stale = days >= policy.repoUnreachableDays;
  if (stale && !lock.staleIssue) lock.staleIssue = await openStaleIssue(entry, policy.repoUnreachableDays);
  report.push(`- ⚠️ \`${entry.id}\` ${warning.code}: ${warning.message}${stale ? "（stale）" : ""}`);

  const previous = await previousEntry(entry.id);
  if (!previous) return null;
  return {
    ...(await carryOver(previous)),
    status: entry.status as PluginEntry["status"],
    pinned: entry.pinned ?? false,
    tags: entry.tags,
    risk: [...new Set([...previous.risk, ...(entry.extraRisk ?? [])])],
    stale,
    warnings: [warning]
  };
}

async function publishMirror(
  id: string,
  version: string,
  versionCode: number,
  zipPath: string,
  sha256: string,
  policy: MarketPolicy,
  warnings: PluginWarning[]
): Promise<string | undefined> {
  const target = readMirrorTarget(policy);
  if (target === null) return undefined;

  try {
    const url = await publishMirrorPackage(target, id, version, versionCode, zipPath, sha256);
    report.push(`- 🪞 \`${id}\` ${version} 已镜像到 ${target.registry}`);
    return url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mirrorFailures.push({ id, version, message });
    warnings.push({
      code: "mirror_failed",
      message: `镜像到国内下载源失败，继续使用 GitHub 原地址：${message}`,
      version
    });
    report.push(`- ⚠️ \`${id}\` ${version} 镜像失败: ${message}`);
    return undefined;
  }
}

async function republishMirror(
  entry: MarketSourceEntry,
  tag: string,
  locked: LockRelease,
  asset: GhRelease["assets"][number],
  workDir: string,
  policy: MarketPolicy,
  warnings: PluginWarning[]
): Promise<string | undefined> {
  if (readMirrorTarget(policy) === null) return undefined;

  const zipPath = join(workDir, `${entry.id}-${tag}-mirror.zip`);
  const check = await downloadAndValidate(asset.browser_download_url, zipPath, {
    expectId: entry.id,
    expectTag: tag,
    policy
  });
  if (!check.result.ok || check.sha256 !== locked.sha256) return undefined;

  return await publishMirror(entry.id, locked.version, locked.versionCode, zipPath, check.sha256, policy, warnings);
}

async function acceptNewReleases(
  entry: MarketSourceEntry,
  repo: GhRepo,
  releases: GhRelease[],
  lock: LockPlugin,
  policy: MarketPolicy,
  workDir: string,
  warnings: PluginWarning[]
): Promise<void> {
  const assetName = `${entry.id}.zip`;
  const ascending = [...releases].sort((a, b) => publishedAt(a).localeCompare(publishedAt(b)));
  const newest = ascending.at(-1);

  for (const release of ascending) {
    const tag = release.tag_name;
    const version = tag.slice(1);
    const asset = release.assets.find((item) => item.name === assetName && item.state === "uploaded");
    const locked = lock.releases[tag];

    if (locked) {
      const changed =
        !asset ||
        asset.id !== locked.assetId ||
        asset.size !== locked.size ||
        (asset.digest ? asset.digest !== `sha256:${locked.sha256}` : false);
      if (changed) {
        warnings.push({ code: "asset_changed", message: `${tag} 的 ${assetName} 在收录后被替换或删除，继续使用收录时的记录`, version });
      }
      if (locked.mirrorUrl === undefined && asset !== undefined) {
        locked.mirrorUrl = await republishMirror(entry, tag, locked, asset, workDir, policy, warnings);
      }
      continue;
    }
    if (!asset) {
      if (release === newest) {
        warnings.push({ code: "missing_asset", message: `${tag} 缺少 ${assetName} 附件`, version });
      }
      continue;
    }

    const rejected = lock.rejected[tag];
    if (rejected && rejected.assetId === asset.id) {
      warnings.push({ code: rejected.code, message: rejected.message, version });
      continue;
    }

    const reject = (code: WarningCode, message: string) => {
      lock.rejected[tag] = { assetId: asset.id, code, message };
      warnings.push({ code, message, version });
      report.push(`- ❌ \`${entry.id}\` ${tag} ${code}: ${message}`);
    };

    if (asset.size > policy.maxZipBytes) {
      reject("invalid_package", `${assetName} 大小 ${asset.size} 超过上限 ${policy.maxZipBytes}`);
      continue;
    }

    const coverStem = join(workDir, `${entry.id}-${tag}-cover`);
    const zipPath = join(workDir, `${entry.id}-${tag}.zip`);
    const { result, sha256, size } = await downloadAndValidate(
      asset.browser_download_url,
      zipPath,
      { expectId: entry.id, expectTag: tag, policy, coverOut: coverStem }
    );
    if (!result.ok) {
      const codes = result.errors.map((error) => `${error.code} ${error.detail}`).join("; ");
      reject(result.errors.some((error) => error.code === "ID_MISMATCH") ? "id_mismatch" : "invalid_package", codes);
      continue;
    }

    const versionCode = result.manifest.versionCode as number;
    if (versionCode <= lock.maxVersionCode) {
      reject("version_not_increased", `${tag} 的 versionCode ${versionCode} 未大于已收录的 ${lock.maxVersionCode}`);
      continue;
    }

    const mirrorUrl = await publishMirror(entry.id, version, versionCode, zipPath, sha256, policy, warnings);

    let cover = "";
    if (result.coverFile) {
      cover = `${entry.id}-${versionCode}${basename(result.coverFile).slice(basename(coverStem).length)}`;
      await mkdir(lockCoversDir, { recursive: true });
      await copyFile(result.coverFile, join(lockCoversDir, cover));
    }

    lock.releases[tag] = {
      version,
      versionCode,
      commit: await resolveTagCommit(repo.full_name, tag),
      assetId: asset.id,
      assetName,
      size,
      sha256,
      mirrorUrl,
      verifiedAt: now.toISOString(),
      hasAppSetting: result.hasAppSetting,
      cover,
      manifest: result.manifest
    };
    delete lock.rejected[tag];
    lock.maxVersionCode = versionCode;
    report.push(`- ✅ \`${entry.id}\` accepted ${tag} (versionCode ${versionCode}, sha256 ${sha256.slice(0, 12)})`);
  }
}

/** 收录时的附件是否仍原样存在，被替换或删除后不再使用镜像，避免继续下发旧包。 */
function assetIntact(locked: LockRelease, asset: GhRelease["assets"][number] | undefined): boolean {
  if (asset === undefined || asset.id !== locked.assetId || asset.size !== locked.size) return false;
  return asset.digest ? asset.digest === `sha256:${locked.sha256}` : true;
}

/**
 * 制品库里是否还留着这个版本。
 *
 * 保留多少个版本由制品库自己的清理策略决定 构建不复制这份判断；
 * 读不到时按「还在」处理 一次接口抖动不该把整批镜像地址都撤掉。
 */
function mirroredIn(files: PackageFile[] | null, id: string, locked: LockRelease): boolean {
  if (files === null) return true;
  const name = `${id}-${packageVersion(locked.version, locked.versionCode)}.zip`;
  return files.some((file) => file.name === name || file.sha256 === locked.sha256);
}

function toRelease(
  id: string,
  tag: string,
  locked: LockRelease,
  live: GhRelease,
  repo: GhRepo,
  files: PackageFile[] | null
): PluginRelease {
  const asset = live.assets.find((item) => item.id === locked.assetId);
  const githubUrl =
    asset?.browser_download_url ??
    `https://github.com/${repo.full_name}/releases/download/${encodeURIComponent(tag)}/${locked.assetName}`;
  const mirrorUrl = assetIntact(locked, asset) && mirroredIn(files, id, locked) ? locked.mirrorUrl : undefined;
  const sources: Record<string, string> = { github: githubUrl };
  if (mirrorUrl !== undefined) sources.cnb = mirrorUrl;
  return {
    version: locked.version,
    versionCode: locked.versionCode,
    tag,
    commit: locked.commit,
    prerelease: live.prerelease,
    immutable: live.immutable ?? false,
    publishedAt: publishedAt(live),
    changelogHtml: renderSafeHtml(live.body_html, repo.full_name, locked.commit),
    downloadUrl: mirrorUrl ?? githubUrl,
    sources,
    assetName: locked.assetName,
    size: locked.size,
    sha256: locked.sha256
  };
}

/** 下载量按两个源合计 GitHub 已收录版本的附件下载 + 制品库的拉取总量 */
async function countDownloads(
  entry: MarketSourceEntry,
  releases: GhRelease[],
  lock: LockPlugin,
  policy: MarketPolicy
): Promise<number> {
  const counted = new Set(Object.values(lock.releases).map((release) => release.assetId));
  const github = releases
    .flatMap((release) => release.assets)
    .filter((asset) => counted.has(asset.id))
    .reduce((total, asset) => total + asset.download_count, 0);

  const target = readMirrorTarget(policy);
  const pulled = target === null ? null : await readPackageDownloads(target, entry.id);
  if (pulled !== null) lock.cnbDownloads = pulled;
  return github + (pulled ?? lock.cnbDownloads ?? 0);
}

async function processPlugin(
  entry: MarketSourceEntry,
  lockFile: Lock,
  policy: MarketPolicy,
  workDir: string
): Promise<BuiltPlugin | null> {
  if (lockFile[entry.id]?.repoId !== entry.repoId) lockFile[entry.id] = freshLock(entry);
  const lock = lockFile[entry.id];

  const repo = await orNull(github<GhRepo>(`/repositories/${entry.repoId}`));
  if (!repo || repo.private) {
    const byName = await orNull(github<GhRepo>(`/repos/${entry.repo}`)).catch(() => null);
    const warning: PluginWarning =
      byName && byName.id !== entry.repoId
        ? { code: "repo_identity_changed", message: `${entry.repo} 现在指向另一个仓库（repoId ${byName.id}），已停止同步` }
        : { code: "repo_unreachable", message: "仓库暂时无法访问，展示上一次同步的数据" };
    return fallbackEntry(entry, lock, policy, warning);
  }
  if (policy.bannedUsers.includes(repo.owner.login)) {
    report.push(`- ⛔ \`${entry.id}\` owner ${repo.owner.login} is banned`);
    return null;
  }

  delete lock.unreachableSince;
  delete lock.staleIssue;
  if (repo.full_name !== entry.repo) report.push(`- ℹ️ \`${entry.id}\` renamed: ${entry.repo} → ${repo.full_name}`);
  lock.repo = repo.full_name;

  const warnings: PluginWarning[] = [];
  const releases = await listReleases(repo.full_name);
  await acceptNewReleases(entry, repo, releases, lock, policy, workDir, warnings);

  // 上传之后再看一遍制品库里实际还留着哪些版本 索引只给仍然存在的版本附镜像地址
  const mirrorTarget = readMirrorTarget(policy);
  const files = mirrorTarget === null ? null : await readPackageFiles(mirrorTarget, entry.id);

  const live = new Map(releases.map((release) => [release.tag_name, release]));
  const accepted = Object.entries(lock.releases)
    .filter(([tag]) => live.has(tag))
    .map(([tag, locked]) => toRelease(entry.id, tag, locked, live.get(tag)!, repo, files))
    .sort((a, b) => b.versionCode - a.versionCode);
  if (accepted.length === 0) {
    report.push(`- ⏸️ \`${entry.id}\` has no accepted release yet, not published`);
    return null;
  }

  const latest = accepted.find((release) => !release.prerelease) ?? null;
  const latestBeta =
    accepted.find((release) => release.prerelease && (!latest || release.versionCode > latest.versionCode)) ?? null;
  const primary = latest ?? latestBeta!;
  const primaryLock = lock.releases[primary.tag];
  const manifest = primaryLock.manifest;
  const author = (manifest.author ?? {}) as { name?: string; url?: string };

  const readme = await orNull(
    githubText(`/repos/${repo.full_name}/readme?ref=${primary.commit}`, "application/vnd.github.html+json")
  );
  const downloads = await countDownloads(entry, releases, lock, policy);

  return {
    id: entry.id,
    name: String(manifest.name),
    summary: String(manifest.summary),
    repo: repo.html_url,
    repoId: repo.id,
    author: { name: author.name ?? repo.owner.login, url: author.url ?? repo.owner.html_url },
    cover: primaryLock.cover ? `covers/${primaryLock.cover}` : "",
    stars: repo.stargazers_count,
    downloads,
    stale: false,
    readmeHtml: renderSafeHtml(readme ?? "", repo.full_name, primary.commit),
    tags: entry.tags,
    risk: [...new Set([...((manifest.risk as RiskTag[]) ?? []), ...(entry.extraRisk ?? [])])],
    status: entry.status as PluginEntry["status"],
    pinned: entry.pinned ?? false,
    warnings,
    compatibility: manifest.compatibility as PluginCompatibility,
    capabilities: {
      hasAppSetting: primaryLock.hasAppSetting,
      defaultGroup: Boolean(manifest.defaultGroup),
      needNotify: Boolean(manifest.needNotify)
    },
    latest,
    latestBeta,
    releases: accepted.slice(0, policy.keepReleases),
    updatedAt: [latest, latestBeta].filter(Boolean).map((release) => release!.publishedAt).sort().at(-1)!
  };
}

const STATUS_RANK: Record<PluginEntry["status"], number> = { listed: 0, deprecated: 1, hidden: 2, suspended: 3 };

function sortPlugins<T extends PluginEntry>(plugins: T[]): T[] {
  return plugins.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const statusDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (statusDiff !== 0) return statusDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function toSearchEntry(plugin: PluginEntry): SearchEntry {
  return {
    id: plugin.id,
    name: plugin.name,
    summary: plugin.summary,
    author: plugin.author.name,
    tags: plugin.tags,
    risk: plugin.risk
  };
}

/** 索引里不放每次构建都会变的统计字段 写盘前拆成两份 */
function splitStats(plugins: BuiltPlugin[]): { entries: PluginEntry[]; stats: Record<string, PluginStats> } {
  const stats: Record<string, PluginStats> = {};
  const entries = plugins.map(({ stars, downloads, ...entry }) => {
    stats[entry.id] = { stars, downloads };
    return entry;
  });
  return { entries, stats };
}

/** 把封面复制到索引目录 源文件缺失时清掉地址 免得索引里留下指向空文件的链接 */
async function syncCovers(entries: PluginEntry[]): Promise<void> {
  for (const plugin of entries) {
    if (!plugin.cover) continue;
    const source = join(lockCoversDir, basename(plugin.cover));
    if (!existsSync(source)) {
      plugin.cover = "";
      continue;
    }
    await mkdir(join(apiDir, "covers"), { recursive: true });
    await copyFile(source, join(apiDir, plugin.cover));
  }
}

async function writeApi(plugins: BuiltPlugin[]): Promise<void> {
  await rm(apiDir, { recursive: true, force: true });
  await mkdir(join(apiDir, "plugins"), { recursive: true });

  const { entries, stats } = splitStats(plugins);
  await syncCovers(entries);

  const index: MarketIndex = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    buildId: process.env.GITHUB_SHA ?? "local",
    pluginCount: entries.length
  };
  await writeJson(join(apiDir, "index.json"), index);
  await writeJson(join(apiDir, "stats.json"), stats);
  await writeJson(join(apiDir, "plugins.json"), entries);
  await writeJson(
    join(apiDir, "search-index.json"),
    entries.filter((plugin) => plugin.status === "listed" || plugin.status === "deprecated").map(toSearchEntry)
  );
  for (const plugin of entries) {
    await writeJson(join(apiDir, "plugins", `${plugin.id}.json`), plugin);
  }
}

/** 把生成的 plugins.json 也发一份到镜像仓，客户端才能按下载源切换索引。 */
async function publishIndexMirror(policy: MarketPolicy): Promise<void> {
  const target = readMirrorTarget(policy);
  if (target === null) return;

  try {
    const url = await publishIndexFile(
      target,
      await readFile(join(apiDir, "plugins.json")),
      join(apiDir, "covers")
    );
    report.push(`- ✅ index mirrored -> ${url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.push(`- ⚠️ index mirror failed: ${message}`);
  }
}

async function main(): Promise<void> {
  const policy = await readPolicy();
  // 策略里开着镜像但配置不全时 静默跳过会让人以为镜像是好的
  if (policy.mirror?.enabled && readMirrorTarget(policy) === null) {
    report.push("- ⚠️ mirror 已启用但 repo / pypi / token 配置不完整，本次跳过镜像");
  }
  const { entries, errors } = checkEntries(await readEntryFiles(), policy);
  if (errors.length > 0) throw new Error(`market entries are invalid:\n${errors.join("\n")}`);

  const lock = await readLock();
  const workDir = await mkdtemp(join(tmpdir(), "zzzod-market-"));
  const plugins: BuiltPlugin[] = [];
  try {
    for (const entry of entries) {
      if (entry.status === "removed" || policy.bannedRepoIds.includes(entry.repoId)) continue;
      try {
        const plugin = await processPlugin(entry, lock, policy, workDir);
        if (plugin) plugins.push(plugin);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.push(`- ❌ \`${entry.id}\` sync failed: ${message}`);
        const previous = await previousEntry(entry.id);
        if (previous) plugins.push(await carryOver(previous));
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const sorted = sortPlugins(plugins);
  await openMirrorIssue();
  await writeApi(sorted);
  await publishIndexMirror(policy);
  await writeJson(lockPath, lock);

  const summary = [`## Market build`, ``, `Published ${sorted.length} / ${entries.length} plugins.`, ``, ...report].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
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
} from "@/lib/types";
import { assetDigest, GitHubError, type GhRelease, type GhRepo, github, githubText, listReleases, orNull, resolveTagCommit } from "./lib/github";
import type { Lock, LockPlugin, LockRelease } from "./lib/lock";
import { notifyRevoked } from "./lib/issues/revoked";
import { openStaleIssue } from "./lib/issues/stale";
import { renderSafeHtml } from "./lib/html";
import { publishIndexFile, readIndexTarget } from "./lib/cnb";
import { checkEntries, readEntryFiles, readPolicy, rootDir } from "./lib/market";
import { parseMirrors, type MirrorHost, type MirrorRepo } from "./lib/mirror";
import { downloadAndValidate } from "./lib/validator";

/** 构建过程中的条目 统计字段写盘时单独存进 stats.json */
type BuiltPlugin = PluginEntry & PluginStats;

const lockDir = resolve(process.env.LOCK_DIR ?? join(rootDir, ".lock"));
const lockPath = join(lockDir, "sources.lock.json");
const lockCoversDir = join(lockDir, "covers");
const apiDir = join(rootDir, "public", "api", "v1");
const previousApiBase = (process.env.PREVIOUS_API_URL ?? "").trim();
/** 统一补上结尾斜杠 相对地址才能正确拼到上一版目录下 */
const previousApiUrl = previousApiBase === "" ? "" : `${previousApiBase.replace(/\/+$/, "")}/`;
/** 模板仓检出目录 与 validator 用的是同一个环境变量 */
const templateDir = resolve(process.env.TEMPLATE_DIR ?? ".plugin-template");
/** 自动 issue 要写进去的仓库 空串表示这轮不发（本地跑默认不发） */
const issueTarget =
  process.env.MARKET_OPEN_ISSUES === "true" ? (process.env.GITHUB_REPOSITORY ?? "").trim() : "";
const runGit = promisify(execFile);
const now = new Date();
const report: string[] = [];

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
async function previousStatsFor(id: string): Promise<PluginStats> {
  return (await previousStats())[id] ?? { stars: 0, downloads: 0 };
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

/** 拼 release 附件地址：站点 + 仓库坐标 + 该站的 release 路径 + tag + 附件名 */
function releaseAssetUrl(origin: string, repo: string, releasePath: string, tag: string, assetName: string): string {
  const path = repo
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/${path}${releasePath}/${encodeURIComponent(tag)}/${assetName}`;
}

/** 由仓库与 tag 拼 GitHub 下载地址 不依赖上一次索引里记的地址；仓库可以给 owner/repo 或仓库页地址 */
function githubAssetUrl(repo: string, tag: string, assetName: string): string {
  const full = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
  return releaseAssetUrl("https://github.com", full, "/releases/download", tag, assetName);
}

/** 两家的 release 路径格式不一样，cnb 多一层 `/-/` */
const MIRROR_RELEASE_PATH: Record<MirrorHost, string> = {
  cnb: "/-/releases/download",
  gitee: "/releases/download"
};

/** 镜像仓库拼成这一版的下载地址 */
function mirrorAssetUrl(target: MirrorRepo, tag: string, assetName: string): string {
  return releaseAssetUrl(target.origin, target.repo, MIRROR_RELEASE_PATH[target.host], tag, assetName);
}

/** 下载地址表：作者声明的镜像 + GitHub 原址 后者恒由构建填 */
function buildSources(
  targets: MirrorRepo[],
  tag: string,
  assetName: string,
  githubUrl: string
): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const target of targets) sources[target.host] = mirrorAssetUrl(target, tag, assetName);
  sources.github = githubUrl;
  return sources;
}

/** 整条沿用上一次构建的结果：下载地址重排为「GitHub 原址 + 作者声明」，统计值以 stats.json 为准 */
async function carryOver(previous: PreviousEntry, mirrors: MirrorRepo[]): Promise<BuiltPlugin> {
  const entry = { ...previous };
  delete entry.stars;
  delete entry.downloads;
  const normalize = (release: PluginRelease): PluginRelease => {
    const kept = release.sources?.github;
    const githubUrl =
      kept !== undefined && kept.startsWith("https://github.com/")
        ? kept
        : githubAssetUrl(entry.repo, release.tag, release.assetName);
    return {
      ...release,
      downloadUrl: githubUrl,
      sources: buildSources(mirrors, release.tag, release.assetName, githubUrl)
    };
  };
  return {
    ...entry,
    releases: (entry.releases ?? []).map(normalize),
    latest: entry.latest ? normalize(entry.latest) : null,
    latestBeta: entry.latestBeta ? normalize(entry.latestBeta) : null,
    ...(await previousStatsFor(entry.id))
  };
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
  if (stale && !lock.staleIssue) lock.staleIssue = await openStaleIssue(entry, policy.repoUnreachableDays, issueTarget);
  report.push(`- ⚠️ \`${entry.id}\` ${warning.code}: ${warning.message}${stale ? "（stale）" : ""}`);

  const previous = await previousEntry(entry.id);
  if (!previous) return null;
  return {
    ...(await carryOver(previous, parseMirrors(entry.mirror))),
    status: entry.status as PluginEntry["status"],
    pinned: entry.pinned ?? false,
    tags: entry.tags,
    risk: [...new Set([...(previous.risk ?? []), ...(entry.extraRisk ?? [])])],
    stale,
    warnings: [warning]
  };
}

/** 把这个版本标记为下架：下架时间只写一次 之后每轮只重复告警 */
function revokeRelease(
  entryId: string,
  tag: string,
  release: LockRelease,
  code: "asset_changed" | "missing_asset",
  detail: string,
  warnings: PluginWarning[]
): void {
  if (!release.revokedAt) {
    release.revokedAt = now.toISOString();
    release.revokedReason = code;
  }
  warnings.push({ code, message: `${detail}，该版本已下架`, version: release.version });
  report.push(`- ⛔ \`${entryId}\` ${tag} ${code}: ${detail}`);
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
      // 已收录版本只认内容：附件换了但摘要一致，说明重传的是同一份文件，
      // 客户端照样校验得过，认下新的 id 继续收录；摘要不同或拿不到才下架
      if (!asset) {
        revokeRelease(entry.id, tag, locked, "missing_asset", `${assetName} 已从 release 中删除`, warnings);
      } else if (asset.id !== locked.assetId) {
        const digest = assetDigest(asset);
        if (digest !== null && digest === locked.sha256) {
          locked.assetId = asset.id;
          report.push(`- ♻️ \`${entry.id}\` ${tag} 附件被重传，内容一致，继续收录`);
        } else {
          revokeRelease(entry.id, tag, locked, "asset_changed", `${assetName} 在收录后被替换`, warnings);
        }
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
      verifiedAt: now.toISOString(),
      hasAppSetting: result.hasAppSetting,
      cover,
      manifest: result.manifest
    };
    delete lock.rejected[tag];
    lock.maxVersionCode = versionCode;
    report.push(`- ✅ \`${entry.id}\` accepted ${tag} (versionCode ${versionCode}, sha256 ${sha256.slice(0, 12)})`);
  }

  // 列表里没有的已收录版本：整个 release 可能被删了，也可能只是超出 50 条的列表窗口。
  // 只探这几个 tag，正常插件一个额外请求都不会发。
  const present = new Set(releases.map((release) => release.tag_name));
  for (const [tag, locked] of Object.entries(lock.releases)) {
    if (present.has(tag) || locked.revokedAt) continue;
    let found: GhRelease | null = null;
    try {
      found = await github<GhRelease>(`/repos/${repo.full_name}/releases/tags/${tag}`);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) {
        const message = error instanceof Error ? error.message : String(error);
        report.push(`- ⚠️ \`${entry.id}\` ${tag} 是否还在无法确认（${message}），本轮跳过`);
        continue;
      }
    }
    if (found) {
      // 只是被列表窗口截掉了 补回列表 版本照常展示
      releases.push(found);
      report.push(`- ℹ️ \`${entry.id}\` ${tag} 不在本次列表里，已单独补拉`);
      continue;
    }
    revokeRelease(entry.id, tag, locked, "missing_asset", `${tag} 的 release 已在 GitHub 上删除`, warnings);
  }
}

/** 索引里每个版本给出的下载地址：GitHub 原址打底 再并上作者声明的镜像 */
function toRelease(
  tag: string,
  locked: LockRelease,
  live: GhRelease,
  repo: GhRepo,
  mirrors: MirrorRepo[]
): PluginRelease {
  const asset = live.assets.find((item) => item.id === locked.assetId);
  const githubUrl = asset?.browser_download_url ?? githubAssetUrl(repo.full_name, tag, locked.assetName);
  return {
    version: locked.version,
    versionCode: locked.versionCode,
    tag,
    commit: locked.commit,
    prerelease: live.prerelease,
    immutable: live.immutable ?? false,
    publishedAt: publishedAt(live),
    changelogHtml: renderSafeHtml(live.body_html, repo.full_name, locked.commit),
    downloadUrl: githubUrl,
    sources: buildSources(mirrors, tag, locked.assetName, githubUrl),
    assetName: locked.assetName,
    size: locked.size,
    sha256: locked.sha256
  };
}

/** 已收录版本的 GitHub 附件下载量 下架的版本不再分发 一并剔除 */
function countDownloads(releases: GhRelease[], lock: LockPlugin): number {
  const counted = new Set(
    Object.values(lock.releases)
      .filter((release) => !release.revokedAt)
      .map((release) => release.assetId)
  );
  return releases
    .flatMap((release) => release.assets)
    .filter((asset) => counted.has(asset.id))
    .reduce((total, asset) => total + asset.download_count, 0);
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
  // 收录之前先记下市场已经收到的最大版本号 通知里用来判断作者是不是补发了新版本
  const baseline = lock.maxVersionCode;
  await acceptNewReleases(entry, repo, releases, lock, policy, workDir, warnings);

  const live = new Map(releases.map((release) => [release.tag_name, release]));
  const mirrors = parseMirrors(entry.mirror);
  const accepted = Object.entries(lock.releases)
    .filter(([tag, locked]) => live.has(tag) && !locked.revokedAt)
    .map(([tag, locked]) => toRelease(tag, locked, live.get(tag)!, repo, mirrors))
    .sort((a, b) => b.versionCode - a.versionCode);
  // 通知发不出去不该影响这轮构建 单独兜住
  try {
    await notifyRevoked({
      target: issueTarget,
      entry,
      repo,
      releases,
      accepted,
      baseline,
      listed: accepted.length > 0,
      lock,
      log: (line) => report.push(line)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.push(`- ⚠️ \`${entry.id}\` 下架通知发送失败: ${message}`);
  }
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
  const downloads = countDownloads(releases, lock);

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

/** 把 plugins.json 与封面同步到镜像仓，客户端才能按下载源切换索引。 */
async function publishIndexMirror(policy: MarketPolicy): Promise<void> {
  const target = readIndexTarget(policy);
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

interface SourceVersion {
  /** 仓库短名 三行 owner 都一样 不必重复 */
  name: string;
  /** 仓库坐标 owner/repo 用来拼链接 */
  repo: string;
  /** tag 或分支名 取不到就留空 */
  version: string;
  /** 提交 SHA */
  sha: string;
}

/** 一次构建由数据 / 市场 / 模板三份代码共同决定 摘要里按调用链顺序列全 */
async function sourceVersions(): Promise<string[]> {
  const lines: string[] = [];

  const data = dataVersion();
  const market = marketVersion();
  const templateRepo = (process.env.TEMPLATE_REPOSITORY ?? "").trim();
  const template: SourceVersion = {
    name: shortRepo(templateRepo) || "template",
    repo: templateRepo,
    version: (process.env.TEMPLATE_REF ?? "").trim(),
    sha: await templateCommit()
  };

  for (const source of [data, market, template]) {
    const line = sourceLine(source);
    if (line !== "") lines.push(`- ${line}`);
  }

  return lines.length === 0 ? [] : ["**Built from**", "", ...lines];
}

/** 一行一项 形如 [`plugin-market@v1`](tag) ([`1f6da8b`](commit)) 点名和版本合成一个链接 */
function sourceLine(source: SourceVersion): string {
  // 本地直接跑脚本时这些环境变量都不存在 拼出来只会剩 data / market / template 三个空壳
  if (source.repo === "") return "";
  const base = repoPage(source.repo);
  const commit = source.sha === "" ? "" : linked(source.sha.slice(0, 7), `${base}/commit/${source.sha}`);
  const target = source.version === "" ? source.name : `${source.name}@${source.version}`;
  const head = linked(target, source.version === "" ? base : `${base}/tree/${source.version}`);
  return commit === "" ? head : `${head} (${commit})`;
}

/** 带代码样式的链接 */
function linked(text: string, url: string): string {
  return `[\`${text}\`](${url})`;
}

function repoPage(repo: string): string {
  const server = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  return `${server}/${repo}`;
}

/** owner/repo 只留 repo 省得三行都在重复同一个 owner */
function shortRepo(repo: string): string {
  return repo.split("/").filter(Boolean).pop() ?? "";
}

function shortRef(rawRef: string): string {
  return rawRef.trim().replace(/^refs\/(tags|heads)\//, "");
}

/** 数据仓就是调用方 三个值都是 Actions 自带的环境变量 */
function dataVersion(): SourceVersion {
  const repo = (process.env.GITHUB_REPOSITORY ?? "").trim();
  return {
    name: shortRepo(repo) || "data",
    repo,
    version: shortRef(process.env.GITHUB_REF ?? ""),
    sha: (process.env.GITHUB_SHA ?? "").trim()
  };
}

/** 市场是 reusable workflow 自己 仓库和版本要从 workflow_ref 里拆 */
function marketVersion(): SourceVersion {
  const ref = (process.env.MARKET_REF ?? "").trim();
  const sha = (process.env.MARKET_SHA ?? "").trim();
  if (ref === "") return { name: "market", repo: "", version: "", sha };

  // 形如 owner/repo/.github/workflows/x.yml@refs/tags/v1
  const [path = "", rawRef = ""] = ref.split("@");
  const repo = path.split("/.github/workflows/")[0] ?? "";
  return { name: shortRepo(repo) || "market", repo, version: shortRef(rawRef), sha };
}

/** 模板仓当前检出的提交 拿不到就留空 不让摘要因此失败 */
async function templateCommit(): Promise<string> {
  try {
    const { stdout } = await runGit("git", ["rev-parse", "HEAD"], { cwd: templateDir });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const policy = await readPolicy();
  // 配了索引镜像但凭证不全时 静默跳过会让人以为镜像在工作；主动关闭的不报
  if (
    policy.mirror?.enabled !== false &&
    policy.mirror?.index !== undefined &&
    readIndexTarget(policy) === null
  ) {
    report.push("- ⚠️ 已配置索引镜像但 repo / token 不完整，本次跳过");
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
        if (previous) plugins.push(await carryOver(previous, parseMirrors(entry.mirror)));
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const sorted = sortPlugins(plugins);
  await writeApi(sorted);
  await publishIndexMirror(policy);
  await writeJson(lockPath, lock);

  // 结果在前 版本信息垫底 免得每次都要先划过三行不变的内容
  const body = [
    `## Market build`,
    ``,
    `Published ${sorted.length} / ${entries.length} plugins.`,
    ``,
    ...report
  ];
  const sources = await sourceVersions();
  if (sources.length > 0) {
    if (body[body.length - 1] !== "") body.push("");
    body.push(...sources);
  }
  const summary = body.join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

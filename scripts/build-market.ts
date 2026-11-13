/**
 * 构建入口：读数据仓条目 → 逐个插件同步 → 写出索引与封面 → 打印构建摘要。
 * 收录、扫描、索引回落、摘要都在这一个文件里，按下面的分节顺序读即可。
 */

import { notifyRevoked } from "./issues/revoked";
import { openStaleIssue } from "./issues/stale";
import { type GhRepo, github, githubText, listReleases, orNull, assetDigest, GitHubError, type GhRelease, resolveTagCommit } from "./lib/github";
import { createBuildContext, lockDirectories, readLock, type BuiltPlugin, type LockPlugin, type BuildContext, type LockRelease } from "./lib/lock";
import { checkEntries, readEntryFiles, readPolicy } from "./lib/market";
import { parseMirrors, buildSources, githubAssetUrl, type MirrorRepo } from "./lib/mirror";
import { downloadAndValidate } from "./lib/validator";
import { readScanRuleVersion, formatFindings } from "./scan/client";
import { notifyPendingSecurityReviews, scanExistingReleases, scanVersion } from "./scan/policy";
import { type MarketSourceEntry, type PluginCompatibility, type PluginEntry, type PluginWarning, type RiskTag, type PluginRelease, type WarningCode, type MarketIndex, type PluginStats, type SearchEntry, type MarketPolicy } from "@/lib/types";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, rm, copyFile, mkdir, writeFile, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { promisify } from "node:util";
import { renderSafeHtml } from "./lib/html";

// ---- 入口：构建编排 ----

async function main(): Promise<void> {
  const policy = await readPolicy();
  const { lockPath } = lockDirectories();
  // 规则版本从扫描器自己读，改动 Python 规则后旧缓存自动失效，不必记得同步改 TS。
  // 读不到时不让整轮构建挂掉：置 0 表示「版本未知」，已有缓存一律不复用；
  // 扫描本身若也起不来，调度层会逐条记跳过，索引照常产出。
  let scanRuleVersion = 0;
  let scanRuleError = "";
  try {
    scanRuleVersion = await readScanRuleVersion();
  } catch (error) {
    scanRuleError = error instanceof Error ? error.message : String(error);
  }
  const ctx = createBuildContext(policy, await readLock(lockPath), scanRuleVersion);
  ctx.report.push(
    scanRuleError
      ? `- ⚠️ 扫描规则版本读取失败，本轮不复用扫描缓存：${scanRuleError.slice(0, 160)}`
      : `- ℹ️ 安全扫描规则版本 ${ctx.scanRuleVersion}`
  );

  // 配了索引镜像但凭证不全时 静默跳过会让人以为镜像在工作；主动关闭的不报
  if (
    policy.mirror?.enabled !== false &&
    policy.mirror?.index !== undefined &&
    readIndexTarget(policy) === null
  ) {
    ctx.report.push("- ⚠️ 已配置索引镜像但 repo / token 不完整，本次跳过");
  }
  const { entries, errors } = checkEntries(await readEntryFiles(), policy);
  if (errors.length > 0) throw new Error(`market entries are invalid:\n${errors.join("\n")}`);

  await ctx.scanCache.load();
  const workDir = await mkdtemp(join(tmpdir(), "zzzod-market-"));
  const plugins: BuiltPlugin[] = [];
  try {
    for (const entry of entries) {
      if (entry.status === "removed" || policy.bannedRepoIds.includes(entry.repoId)) continue;
      try {
        const plugin = await processPlugin(ctx, entry, workDir);
        if (plugin) plugins.push(plugin);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.report.push(`- ❌ \`${entry.id}\` sync failed: ${message}`);
        const previous = await previousEntry(ctx, entry.id);
        if (previous) plugins.push(await carryOver(ctx, previous, parseMirrors(entry.mirror)));
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const sorted = sortPlugins(plugins);
  await writeApi(ctx, sorted);
  await publishIndexMirror(ctx);
  await writeJson(ctx.lockPath, ctx.lock);

  const summary = await renderSummary(ctx, sorted.length, entries.length);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

// ---- 单个插件的收录与同步 ----

function freshLock(entry: MarketSourceEntry): LockPlugin {
  return { repoId: entry.repoId, repo: entry.repo, maxVersionCode: 0, releases: {}, rejected: {} };
}

export async function processPlugin(
  ctx: BuildContext,
  entry: MarketSourceEntry,
  workDir: string
): Promise<BuiltPlugin | null> {
  if (ctx.lock[entry.id]?.repoId !== entry.repoId) ctx.lock[entry.id] = freshLock(entry);
  const lock = ctx.lock[entry.id];

  const repo = await orNull(github<GhRepo>(`/repositories/${entry.repoId}`));
  if (!repo || repo.private) {
    const byName = await orNull(github<GhRepo>(`/repos/${entry.repo}`)).catch(() => null);
    const warning: PluginWarning =
      byName && byName.id !== entry.repoId
        ? { code: "repo_identity_changed", message: `${entry.repo} 现在指向另一个仓库（repoId ${byName.id}），已停止同步` }
        : { code: "repo_unreachable", message: "仓库暂时无法访问，展示上一次同步的数据" };
    return fallbackEntry(ctx, entry, lock, warning);
  }
  if (ctx.policy.bannedUsers.includes(repo.owner.login)) {
    ctx.report.push(`- ⛔ \`${entry.id}\` owner ${repo.owner.login} is banned`);
    return null;
  }

  delete lock.unreachableSince;
  delete lock.staleIssue;
  if (repo.full_name !== entry.repo) ctx.report.push(`- ℹ️ \`${entry.id}\` renamed: ${entry.repo} → ${repo.full_name}`);
  lock.repo = repo.full_name;

  const warnings: PluginWarning[] = [];
  const releases = await listReleases(repo.full_name);
  await acceptNewReleases(ctx, entry, repo, releases, lock, workDir, warnings);
  await scanExistingReleases(ctx, entry, repo, lock, workDir, warnings);

  const live = new Map(releases.map((release) => [release.tag_name, release]));
  const mirrors = parseMirrors(entry.mirror);
  const accepted = Object.entries(lock.releases)
    .filter(([tag, locked]) => live.has(tag) && !locked.revokedAt)
    .map(([tag, locked]) => toRelease(tag, locked, live.get(tag)!, repo, mirrors))
    .sort((a, b) => b.versionCode - a.versionCode);
  // 通知发不出去不该影响这轮构建 单独兜住
  try {
    await notifyRevoked({
      target: ctx.issueTarget,
      entry,
      repo,
      releases,
      listed: accepted.length > 0,
      lock,
      log: (line) => ctx.report.push(line)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.report.push(`- ⚠️ \`${entry.id}\` 下架通知发送失败: ${message}`);
  }
  // 收录和扫描都落定之后再补发通知：发失败不影响本轮收录，下轮还会重试
  await notifyPendingSecurityReviews(ctx, entry, repo, lock);
  if (accepted.length === 0) {
    ctx.report.push(`- ⏸️ \`${entry.id}\` has no accepted release yet, not published`);
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
    releases: accepted.slice(0, ctx.policy.keepReleases),
    updatedAt: [latest, latestBeta].filter(Boolean).map((release) => release!.publishedAt).sort().at(-1)!
  };
}

/** 发布时间取不到时回落到创建时间 */
function publishedAt(release: GhRelease): string {
  return release.published_at ?? release.created_at;
}

/** 把这个版本标记为下架：下架时间只写一次 之后每轮只重复告警 */
export function revokeRelease(
  ctx: BuildContext,
  entryId: string,
  tag: string,
  release: LockRelease,
  code: "asset_changed" | "missing_asset",
  detail: string,
  warnings: PluginWarning[]
): void {
  if (!release.revokedAt) {
    release.revokedAt = ctx.now.toISOString();
    release.revokedReason = code;
  }
  warnings.push({ code, message: `${detail}，该版本已下架`, version: release.version });
  ctx.report.push(`- ⛔ \`${entryId}\` ${tag} ${code}: ${detail}`);
}

export async function acceptNewReleases(
  ctx: BuildContext,
  entry: MarketSourceEntry,
  repo: GhRepo,
  releases: GhRelease[],
  lock: LockPlugin,
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
      // 下架之后作者又把包传回来了：内容跟市场记录一致，就当没被动过，恢复收录
      if (locked.revokedAt) {
        const digest = asset ? assetDigest(asset) : null;
        if (!asset || digest !== locked.sha256) continue;
        delete locked.revokedAt;
        delete locked.revokedReason;
        locked.assetId = asset.id;
        // 这个版本不用再等作者处理了 通知那边的账也要跟着销
        lock.revokedNotified = (lock.revokedNotified ?? []).filter((item) => item !== tag);
        ctx.report.push(`- 🔄 \`${entry.id}\` ${tag} 附件传回了原来的内容，恢复收录`);
        continue;
      }
      // 已收录版本只认内容：附件换了但摘要一致，说明重传的是同一份文件，
      // 客户端照样校验得过，认下新的 id 继续收录；摘要不同或拿不到才下架
      if (!asset) {
        revokeRelease(ctx, entry.id, tag, locked, "missing_asset", `${assetName} 已从 release 中删除`, warnings);
      } else if (asset.id !== locked.assetId) {
        const digest = assetDigest(asset);
        if (digest !== null && digest === locked.sha256) {
          locked.assetId = asset.id;
          ctx.report.push(`- ♻️ \`${entry.id}\` ${tag} 附件被重传，内容一致，继续收录`);
        } else {
          revokeRelease(ctx, entry.id, tag, locked, "asset_changed", `${assetName} 在收录后被替换`, warnings);
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
      ctx.report.push(`- ❌ \`${entry.id}\` ${tag} ${code}: ${message}`);
    };

    if (asset.size > ctx.policy.maxZipBytes) {
      reject("invalid_package", `${assetName} 大小 ${asset.size} 超过上限 ${ctx.policy.maxZipBytes}`);
      continue;
    }

    const coverStem = join(workDir, `${entry.id}-${tag}-cover`);
    const zipPath = join(workDir, `${entry.id}-${tag}.zip`);
    const { result, sha256, size } = await downloadAndValidate(
      asset.browser_download_url,
      zipPath,
      { expectId: entry.id, expectTag: tag, policy: ctx.policy, coverOut: coverStem }
    );
    if (!result.ok) {
      const codes = result.errors.map((error) => `${error.code} ${error.detail}`).join("; ");
      reject(result.errors.some((error) => error.code === "ID_MISMATCH") ? "id_mismatch" : "invalid_package", codes);
      continue;
    }

    // 新版本在这一步扫一次，结果按 sha256 存进缓存，之后每轮直接复用
    const scan = await scanVersion(ctx, entry.id, tag, sha256, async () => zipPath);
    if (scan) {
      if (scan.summary.block > 0) {
        reject("invalid_package", `安全扫描拦截：${formatFindings(scan, "block")}`);
        continue;
      }
    }

    const versionCode = result.manifest.versionCode as number;
    if (versionCode <= lock.maxVersionCode) {
      reject("version_not_increased", `${tag} 的 versionCode ${versionCode} 未大于已收录的 ${lock.maxVersionCode}`);
      continue;
    }

    let cover = "";
    if (result.coverFile) {
      cover = `${entry.id}-${versionCode}${basename(result.coverFile).slice(basename(coverStem).length)}`;
      await mkdir(ctx.lockCoversDir, { recursive: true });
      await copyFile(result.coverFile, join(ctx.lockCoversDir, cover));
    }

    lock.releases[tag] = {
      version,
      versionCode,
      commit: await resolveTagCommit(repo.full_name, tag),
      assetId: asset.id,
      assetName,
      size,
      sha256,
      verifiedAt: ctx.now.toISOString(),
      hasAppSetting: result.hasAppSetting,
      cover,
      manifest: result.manifest
    };
    delete lock.rejected[tag];
    lock.maxVersionCode = versionCode;
    ctx.report.push(`- ✅ \`${entry.id}\` accepted ${tag} (versionCode ${versionCode}, sha256 ${sha256.slice(0, 12)})`);
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
        ctx.report.push(`- ⚠️ \`${entry.id}\` ${tag} 是否还在无法确认（${message}），本轮跳过`);
        continue;
      }
    }
    if (found) {
      // 只是被列表窗口截掉了 补回列表 版本照常展示
      releases.push(found);
      ctx.report.push(`- ℹ️ \`${entry.id}\` ${tag} 不在本次列表里，已单独补拉`);
      continue;
    }
    revokeRelease(ctx, entry.id, tag, locked, "missing_asset", `${tag} 的 release 已在 GitHub 上删除`, warnings);
  }
}

/** 索引里每个版本给出的下载地址：GitHub 原址打底 再并上作者声明的镜像 */
export function toRelease(
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
export function countDownloads(releases: GhRelease[], lock: LockPlugin): number {
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

// ---- 索引、封面与镜像产物 ----

export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

const STATUS_RANK: Record<PluginEntry["status"], number> = {
  listed: 0,
  deprecated: 1,
  hidden: 2,
  suspended: 3
};

export function sortPlugins<T extends PluginEntry>(plugins: T[]): T[] {
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
async function syncCovers(ctx: BuildContext, entries: PluginEntry[]): Promise<void> {
  for (const plugin of entries) {
    if (!plugin.cover) continue;
    const source = join(ctx.lockCoversDir, basename(plugin.cover));
    if (!existsSync(source)) {
      plugin.cover = "";
      continue;
    }
    await mkdir(join(ctx.apiDir, "covers"), { recursive: true });
    await copyFile(source, join(ctx.apiDir, plugin.cover));
  }
}

export async function writeApi(ctx: BuildContext, plugins: BuiltPlugin[]): Promise<void> {
  await rm(ctx.apiDir, { recursive: true, force: true });
  await mkdir(join(ctx.apiDir, "plugins"), { recursive: true });

  const { entries, stats } = splitStats(plugins);
  await syncCovers(ctx, entries);

  const index: MarketIndex = {
    schemaVersion: 1,
    generatedAt: ctx.now.toISOString(),
    buildId: process.env.GITHUB_SHA ?? "local",
    pluginCount: entries.length
  };
  await writeJson(join(ctx.apiDir, "index.json"), index);
  await writeJson(join(ctx.apiDir, "stats.json"), stats);
  await writeJson(join(ctx.apiDir, "plugins.json"), entries);
  await writeJson(
    join(ctx.apiDir, "search-index.json"),
    entries.filter((plugin) => plugin.status === "listed" || plugin.status === "deprecated").map(toSearchEntry)
  );
  for (const plugin of entries) {
    await writeJson(join(ctx.apiDir, "plugins", `${plugin.id}.json`), plugin);
  }
}

const DEFAULT_API = "https://api.cnb.cool";
const SITE_ROOT = "https://cnb.cool";
const runGit = promisify(execFile);

const INDEX_FILE = "plugins.json";

export interface IndexTarget {
  /** 索引与封面镜像到的仓库 */
  repo: string;
  /** 提交到的分支 */
  branch: string;
  token: string;
  /** CNB OpenAPI 地址 用来推算仓库地址 */
  api: string;
}

/** 取第一个非空值 工作流里没配的 secret 是空串 只判断 ?? 会漏掉回落 */
function envValue(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** 索引镜像目标：配了 mirror.index 且未被关闭、仓库与令牌齐全才有，否则不做索引镜像 */
export function readIndexTarget(policy: MarketPolicy): IndexTarget | null {
  const mirror = policy.mirror;
  if (mirror?.enabled === false) return null;
  if (mirror?.index === undefined) return null;

  const repo = envValue(process.env.CNB_MIRROR_REPO, mirror.index.repo);
  const token = envValue(process.env.CNB_TOKEN);
  if (repo === "" || token === "") return null;

  return {
    repo,
    token,
    api: envValue(process.env.CNB_API_ENDPOINT, mirror.api, DEFAULT_API).replace(/\/+$/, ""),
    branch: envValue(process.env.CNB_MIRROR_BRANCH, mirror.index.branch, "main")
  };
}

function siteUrlOf(target: IndexTarget): string {
  return target.api === DEFAULT_API ? SITE_ROOT : target.api;
}

function redact(text: string, token: string): string {
  return text.split(token).join("***").split(encodeURIComponent(token)).join("***");
}

/**
 * 把索引和封面作为普通文件提交到镜像仓，客户端用 raw 直链读取。
 *
 * 镜像仓只放市场自己产出的这两样东西，插件包与市场网页都不进来。
 * 内容没变就不提交，避免定时构建把仓库历史堆满。
 */
export async function publishIndexFile(
  target: IndexTarget,
  data: Buffer,
  coversDir: string
): Promise<string> {
  const remote = `${siteUrlOf(target)}/${target.repo}`;
  const url = `${remote}/-/git/raw/${target.branch}/${INDEX_FILE}`;
  const dir = await mkdtemp(join(tmpdir(), "cnb-index-"));
  const authRemote = remote.replace("://", `://cnb:${encodeURIComponent(target.token)}@`);
  try {
    await runGit("git", ["clone", "-q", "--depth", "1", "--branch", target.branch, authRemote, dir]);
    await writeFile(join(dir, INDEX_FILE), data);
    // 封面跟索引放同级，客户端按「索引目录 + cover」拼地址；每次只保留本次构建引用的封面
    await rm(join(dir, "covers"), { recursive: true, force: true });
    if (existsSync(coversDir)) await cp(coversDir, join(dir, "covers"), { recursive: true });
    await runGit("git", ["add", "-A"], { cwd: dir });
    const staged = await runGit("git", ["status", "--porcelain"], { cwd: dir });
    if (staged.stdout.trim() === "") return url;
    await runGit(
      "git",
      [
        "-c", "user.name=plugin-market",
        "-c", "user.email=plugin-market@users.noreply.github.com",
        "commit", "-q", "-m", `chore: sync index and covers (build ${(process.env.GITHUB_SHA ?? "local").slice(0, 7)})`
      ],
      { cwd: dir }
    );
    await runGit("git", ["push", "-q", authRemote, `HEAD:refs/heads/${target.branch}`], { cwd: dir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`索引推送失败：${redact(message, target.token)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return url;
}

/** 把 plugins.json 与封面同步到镜像仓，客户端才能按下载源切换索引。 */
export async function publishIndexMirror(ctx: BuildContext): Promise<void> {
  const target = readIndexTarget(ctx.policy);
  if (target === null) return;

  try {
    const url = await publishIndexFile(
      target,
      await readFile(join(ctx.apiDir, "plugins.json")),
      join(ctx.apiDir, "covers")
    );
    ctx.report.push(`- ✅ index mirrored -> ${url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.report.push(`- ⚠️ index mirror failed: ${message}`);
  }
}

// ---- 回落上一版索引 ----

/** 上一次构建写出的条目 统计字段由 stats.json 单独提供 */
export type PreviousEntry = PluginEntry & Partial<PluginStats>;

/** 上一次构建的统计值 读一次就缓存 还没有 stats.json 时按空表处理 */
export async function previousStats(ctx: BuildContext): Promise<Record<string, PluginStats>> {
  if (ctx.previousStatsCache !== null) return ctx.previousStatsCache;
  let loaded: Record<string, PluginStats> = {};
  if (ctx.previousApiUrl) {
    try {
      const response = await fetch(new URL("stats.json", ctx.previousApiUrl));
      if (response.ok) {
        loaded = ((await response.json()) as Record<string, PluginStats>) ?? {};
      } else if (response.status !== 404) {
        // 404 就是还没发过 属于正常情况 不用提醒
        ctx.report.push(`- ⚠️ 读不到上一版 stats.json（HTTP ${response.status}），本轮同步失败的插件统计会归零`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.report.push(`- ⚠️ 读取上一版 stats.json 失败（${message}），本轮同步失败的插件统计会归零`);
    }
  }
  ctx.previousStatsCache = loaded;
  return loaded;
}

/** 沿用上一次构建的统计值 免得同步失败的插件被清零 */
export async function previousStatsFor(ctx: BuildContext, id: string): Promise<PluginStats> {
  return (await previousStats(ctx))[id] ?? { stars: 0, downloads: 0 };
}

export async function previousEntry(ctx: BuildContext, id: string): Promise<PreviousEntry | null> {
  if (!ctx.previousApiUrl) return null;
  try {
    const response = await fetch(new URL(`plugins/${id}.json`, ctx.previousApiUrl));
    return response.ok ? ((await response.json()) as PreviousEntry) : null;
  } catch {
    return null;
  }
}

/** 整条沿用上一次构建的结果：下载地址重排为「GitHub 原址 + 作者声明」，统计值以 stats.json 为准 */
export async function carryOver(
  ctx: BuildContext,
  previous: PreviousEntry,
  mirrors: MirrorRepo[]
): Promise<BuiltPlugin> {
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
    ...(await previousStatsFor(ctx, entry.id))
  };
}

/** 仓库这次同步不了：按天计 stale，能拿到上一版就整条沿用 */
export async function fallbackEntry(
  ctx: BuildContext,
  entry: MarketSourceEntry,
  lock: LockPlugin,
  warning: PluginWarning
): Promise<BuiltPlugin | null> {
  lock.unreachableSince ??= ctx.now.toISOString();
  const days = (ctx.now.getTime() - new Date(lock.unreachableSince).getTime()) / 86_400_000;
  const stale = days >= ctx.policy.repoUnreachableDays;
  if (stale && !lock.staleIssue) {
    lock.staleIssue = await openStaleIssue(entry, ctx.policy.repoUnreachableDays, ctx.issueTarget);
  }
  ctx.report.push(`- ⚠️ \`${entry.id}\` ${warning.code}: ${warning.message}${stale ? "（stale）" : ""}`);

  const previous = await previousEntry(ctx, entry.id);
  if (!previous) return null;
  return {
    ...(await carryOver(ctx, previous, parseMirrors(entry.mirror))),
    status: entry.status as PluginEntry["status"],
    pinned: entry.pinned ?? false,
    tags: entry.tags,
    risk: [...new Set([...(previous.risk ?? []), ...(entry.extraRisk ?? [])])],
    stale,
    warnings: [warning]
  };
}

// ---- 构建摘要 ----

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

/** 结果在前 版本信息垫底 免得每次都要先划过三行不变的内容 */
export async function renderSummary(ctx: BuildContext, published: number, total: number): Promise<string> {
  const body = [`## Market build`, ``, `Published ${published} / ${total} plugins.`, ``, ...ctx.report];
  const sources = await sourceVersions(ctx);
  if (sources.length > 0) {
    if (body[body.length - 1] !== "") body.push("");
    body.push(...sources);
  }
  return body.join("\n");
}

/** 一次构建由数据 / 市场 / 模板三份代码共同决定 摘要里按调用链顺序列全 */
async function sourceVersions(ctx: BuildContext): Promise<string[]> {
  const lines: string[] = [];

  const data = dataVersion();
  const market = marketVersion();
  const templateRepo = (process.env.TEMPLATE_REPOSITORY ?? "").trim();
  const template: SourceVersion = {
    name: shortRepo(templateRepo) || "template",
    repo: templateRepo,
    version: (process.env.TEMPLATE_REF ?? "").trim(),
    sha: await templateCommit(ctx)
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
async function templateCommit(ctx: BuildContext): Promise<string> {
  try {
    const { stdout } = await runGit("git", ["rev-parse", "HEAD"], { cwd: ctx.templateDir });
    return stdout.trim();
  } catch {
    return "";
  }
}

// ---- 启动 ----

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

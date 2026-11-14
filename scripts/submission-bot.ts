/**
 * 收录机器人入口：处理 issue 事件、校验提交、开 PR，并在命令触发时发起构建。
 * 运行契约、校验规则与事件分发都在这一个文件里。
 */

import { github, orNull, LABELS, closeIssue as closeIssueRequest, commentIssue, ensureLabels as ensureRepoLabels, type GhRepo, GitHubError } from "./lib/github";
import { readPolicy, ID_PATTERN, MAX_TAGS, TAG_PATTERN, formatEntry } from "./lib/market";
import { pluginsDir } from "./lib/paths";
import { errorMessage, run, withTempDir } from "./lib/runtime";
import { StepSummary } from "./lib/summary";
import { checkLatestRelease } from "./lib/validator";
import { loadHostPackages } from "./scan/host_packages";
import { describeScan, findingLines, scanZip, type ScanCheck, type ScanReport } from "./scan/client";
import { type MarketPolicy, type MarketSourceEntry } from "@/lib/types";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// ---- 入口：事件分发 ----

export const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const PREFIX = /^\s*\[(submission|transfer|report|appeal)\]/i;

async function overRateLimit(ctx: BotContext, login: string, policy: MarketPolicy): Promise<boolean> {
  const since = new Date(Date.now() - policy.rateLimit.windowHours * 3_600_000).toISOString().slice(0, 19);
  const query = `repo:${ctx.marketRepo} is:issue author:${login} "[submission]" in:title created:>=${since}`;
  const result = await github<{ total_count: number }>(`/search/issues?q=${encodeURIComponent(query)}`);
  return result.total_count > policy.rateLimit.maxOpenSubmissionsPerUser;
}

async function handleSubmission(
  ctx: BotContext,
  issue: Issue,
  policy: MarketPolicy,
  trigger: SubmissionTrigger,
  byMaintainer: boolean
): Promise<void> {
  const labels = new Set(issue.labels.map((label) => label.name));
  if (labels.has("approved") || labels.has("spam")) return;
  if (trigger === "edited" && labels.has("pending")) return;
  if (labels.has("needs-review") && !byMaintainer) {
    if (trigger === "recheck") {
      await ctx.comment(issue.number, "该提交需要维护者确认，维护者回复 `/recheck` 后会继续处理。");
    }
    return;
  }

  await ctx.addLabels(issue.number, ["submission"]);
  if (policy.bannedUsers.includes(issue.user.login)) {
    await ctx.addLabels(issue.number, ["rejected"]);
    await ctx.comment(issue.number, "该账号已被禁止提交插件。如有异议请提交 `[appeal]` Issue。");
    await ctx.closeIssue(issue.number, "not_planned");
    return;
  }
  if (trigger === "opened" && (await overRateLimit(ctx, issue.user.login, policy))) {
    await ctx.addLabels(issue.number, ["needs-review"]);
    await ctx.comment(
      issue.number,
      `${policy.rateLimit.windowHours} 小时内提交超过 ${policy.rateLimit.maxOpenSubmissionsPerUser} 次，已转为人工处理。维护者确认后会回复 \`/recheck\`。`
    );
    return;
  }

  await withTempDir("zzzod-submission-", async (workDir) => {
    const check = await checkSubmission(issue, policy, workDir);
    await writeStepSummary(issue, check);
    if (check.errors.length > 0 || !check.entry || !check.preview) {
      await ctx.removeLabels(issue.number, ["pending"]);
      await ctx.addLabels(issue.number, ["rejected"]);
      await ctx.comment(
        issue.number,
        [
          "自动校验未通过：",
          "",
          ...check.errors.map((error) => `- ${error}`),
          "",
          "修复后在本 Issue 回复 `/recheck` 重新校验。插件模板和发布说明见 https://github.com/OneDragon-Anyone/plugin-template 。"
        ].join("\n")
      );
      return;
    }
    await ctx.removeLabels(issue.number, ["rejected", "needs-review"]);
    await openPullRequest(ctx, issue, { ...check, entry: check.entry, preview: check.preview });
  });
}

export async function triggerBuild(ctx: BotContext, issue: Issue): Promise<void> {
  await github(`/repos/${ctx.marketRepo}/actions/workflows/build-market.yml/dispatches`, {
    method: "POST",
    body: { ref: ctx.baseBranch }
  });
  let runUrl = "";
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const runs = await github<{ workflow_runs: { html_url: string }[] }>(
      `/repos/${ctx.marketRepo}/actions/workflows/build-market.yml/runs?event=workflow_dispatch&per_page=1`
    );
    runUrl = runs.workflow_runs[0]?.html_url ?? "";
  } catch {
    // 查询运行链接失败不影响触发结果
  }
  await ctx.comment(issue.number, `已触发立即构建${runUrl ? `：${runUrl}` : ""}。站点与 API 会在几分钟后更新。`);
}

export async function handleIssue(
  ctx: BotContext,
  issue: Issue,
  trigger: IssueTrigger,
  byMaintainer: boolean
): Promise<void> {
  if (issue.pull_request || issue.user.type === "Bot") return;
  const match = PREFIX.exec(issue.title);
  if (!match) {
    if (trigger !== "opened") return;
    await ctx.addLabels(issue.number, ["spam"]);
    await ctx.comment(
      issue.number,
      `标题缺少 \`[submission]\` / \`[transfer]\` / \`[report]\` / \`[appeal]\` 前缀，已自动关闭。请通过${ctx.siteUrl ? `[插件仓库网站](${ctx.siteUrl}) 或` : ""} Issue 模板重新提交。`
    );
    await ctx.closeIssue(issue.number, "not_planned");
    await github(`/repos/${ctx.marketRepo}/issues/${issue.number}/lock`, {
      method: "PUT",
      body: { lock_reason: "spam" }
    });
    return;
  }

  const kind = match[1].toLowerCase();
  if (kind !== "submission") {
    if (trigger === "opened") {
      await ctx.addLabels(issue.number, [kind]);
      await ctx.comment(issue.number, "已收到，维护者会尽快处理。");
    }
    return;
  }
  const policy = await readPolicy();
  await handleSubmission(ctx, issue, policy, trigger === "reopened" ? "recheck" : trigger, byMaintainer);
}

export async function handleClosedPullRequest(ctx: BotContext, pr: PullRequest): Promise<void> {
  if (pr.head.repo?.full_name !== ctx.marketRepo || !pr.head.ref.startsWith("submission/")) return;
  const issueMatch = /Closes #(\d+)/.exec(pr.body ?? "");
  if (issueMatch) {
    const issue = Number(issueMatch[1]);
    await ctx.removeLabels(issue, ["pending"]);
    if (pr.merged) {
      await ctx.addLabels(issue, ["approved"]);
      await ctx.comment(issue, `PR #${pr.number} 已合并，插件已收录。之后发布新 Release 会自动同步。`);
      await ctx.closeIssue(issue, "completed");
    } else {
      await ctx.addLabels(issue, ["rejected"]);
      await ctx.comment(
        issue,
        `PR #${pr.number} 被关闭且未合并，原因请查看 PR 中维护者的说明。如有异议请提交 \`[appeal]\` Issue。`
      );
      await ctx.closeIssue(issue, "not_planned");
    }
  }
  await orNull(github(`/repos/${ctx.marketRepo}/git/refs/heads/${pr.head.ref}`, { method: "DELETE" })).catch(
    () => null
  );
}

async function main(): Promise<void> {
  const ctx = new BotContext();
  if (!ctx.marketRepo) throw new Error("GITHUB_REPOSITORY is required");
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf-8"));

  if (eventName === "issues" && ["opened", "edited", "reopened"].includes(event.action)) {
    await handleIssue(ctx, event.issue as Issue, event.action, false);
  } else if (eventName === "issue_comment" && event.action === "created") {
    const issue = event.issue as Issue;
    const body = String(event.comment.body ?? "").trim();
    const byMaintainer = MAINTAINER_ASSOCIATIONS.has(event.comment.author_association);
    const byAuthor = event.comment.user.login === issue.user.login;
    if (body === "/recheck" && issue.state === "open" && (byMaintainer || byAuthor)) {
      await handleIssue(ctx, issue, "recheck", byMaintainer);
    } else if (body === "/sync" && (byMaintainer || byAuthor)) {
      await triggerBuild(ctx, issue);
    }
  } else if (eventName === "pull_request_target" && event.action === "closed") {
    await handleClosedPullRequest(ctx, event.pull_request as PullRequest);
  }
}

// ---- 运行契约与事件类型 ----

/** 机器人这一轮的环境与 GitHub 写操作，仓库坐标只在这里绑一次 */
export class BotContext {
  readonly marketRepo = (process.env.GITHUB_REPOSITORY ?? "").trim();
  readonly baseBranch = process.env.MARKET_BASE_BRANCH ?? "master";
  readonly siteUrl = process.env.MARKET_SITE_URL ?? "";
  private labelsReady = false;

  private async ensureLabels(): Promise<void> {
    if (this.labelsReady) return;
    await ensureRepoLabels(this.marketRepo, Object.keys(LABELS));
    this.labelsReady = true;
  }

  async addLabels(issue: number, labels: string[]): Promise<void> {
    await this.ensureLabels();
    await github(`/repos/${this.marketRepo}/issues/${issue}/labels`, { method: "POST", body: { labels } });
  }

  async removeLabels(issue: number, labels: string[]): Promise<void> {
    for (const label of labels) {
      await orNull(
        github(`/repos/${this.marketRepo}/issues/${issue}/labels/${encodeURIComponent(label)}`, { method: "DELETE" })
      );
    }
  }

  comment(issue: number, body: string): Promise<void> {
    return commentIssue(this.marketRepo, issue, body);
  }

  closeIssue(issue: number, reason: "completed" | "not_planned"): Promise<void> {
    return closeIssueRequest(this.marketRepo, issue, reason);
  }
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string; type: string };
  labels: { name: string }[];
  pull_request?: unknown;
}

export interface PullRequest {
  number: number;
  merged: boolean;
  body: string | null;
  head: { ref: string; repo: { full_name: string } | null };
}

export type IssueTrigger = "opened" | "edited" | "reopened" | "recheck";
export type SubmissionTrigger = "opened" | "edited" | "recheck";

// ---- 提交校验与开 PR ----

export interface SubmissionCheck {
  errors: string[];
  notes: string[];
  entry?: MarketSourceEntry;
  preview?: string;
  /** 收录前那次安全扫描的结论；没跑起来是 null，跟着 notes 一起交给维护者 */
  scan?: ScanReport | null;
}

export type ReadyCheck = Required<Pick<SubmissionCheck, "entry" | "preview">> & SubmissionCheck;

function parseRepoUrl(body: string): { owner: string; name: string } | null {
  const match = /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?=[/#?\s)>\]]|$)/.exec(body);
  return match ? { owner: match[1], name: match[2] } : null;
}

function parseTags(body: string): string[] {
  // [^\S\n] 匹配除换行外的空白，避免 “tags:” 行为空时捕获到下一节标题
  const match = /(?:^|\n)[^\S\n]*(?:tags[^\S\n]*[:：]|###\s*(?:标签|Tags)\s*\n+[^\S\n]*)([^\n]*)/i.exec(body);
  if (!match || match[1].trim() === "_No response_") return [];
  return [
    ...new Set(
      match[1]
        .split(/[,，\s]+/)
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keysA = Object.keys(left);
  const keysB = Object.keys(right);
  return keysA.length === keysB.length && keysA.every((key) => jsonEqual(left[key], right[key]));
}

/** contents API 回的是 base64，解出来就是文件原文 */
function decodeContent(file: { content: string }): unknown {
  return JSON.parse(Buffer.from(file.content, "base64").toString("utf-8"));
}

async function readManifestFile(fullName: string, path: string, ref: string): Promise<Record<string, unknown>> {
  const file = await github<{ content: string }>(
    `/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`
  );
  return decodeContent(file) as Record<string, unknown>;
}

async function findPackageManifest(
  repo: GhRepo,
  errors: string[],
  notes: string[]
): Promise<Record<string, unknown> | null> {
  const root = await github<{ name: string; type: string }[]>(
    `/repos/${repo.full_name}/contents/?ref=${encodeURIComponent(repo.default_branch)}`
  );
  for (const prefix of ["README", "LICENSE"]) {
    if (!root.some((item) => item.type === "file" && item.name.toUpperCase().startsWith(prefix))) {
      errors.push(`仓库根目录缺少 ${prefix}。`);
    }
  }

  const hasRootManifest = root.some((item) => item.type === "file" && item.name === "plugin.json");
  const manifests: { dir: string; data: Record<string, unknown> }[] = [];
  for (const dir of root.filter((item) => item.type === "dir" && !item.name.startsWith("."))) {
    const file = await orNull(
      github<{ content: string }>(
        `/repos/${repo.full_name}/contents/${encodeURIComponent(dir.name)}/plugin.json?ref=${encodeURIComponent(repo.default_branch)}`
      )
    );
    if (!file) continue;
    try {
      manifests.push({ dir: dir.name, data: decodeContent(file) as Record<string, unknown> });
    } catch {
      errors.push(`\`${dir.name}/plugin.json\` 不是合法 JSON。`);
    }
  }
  if (manifests.length !== 1) {
    errors.push(`仓库根目录下应恰好有一个子目录包含 \`plugin.json\`，实际找到 ${manifests.length} 个。`);
    return null;
  }

  // 旧模板会在根目录留一份同步的 plugin.json：与包内一致时容忍（提示删除），不一致才失败
  if (hasRootManifest) {
    try {
      const rootManifest = await readManifestFile(repo.full_name, "plugin.json", repo.default_branch);
      if (jsonEqual(rootManifest, manifests[0].data)) {
        notes.push("仓库根目录的 `plugin.json` 是旧模板的同步副本，与包内一致；建议删除，不会被读取。");
      } else {
        errors.push("仓库根目录的 `plugin.json` 与插件包内的不一致，请删除根目录副本（参见模板 README）。");
      }
    } catch {
      errors.push("仓库根目录的 `plugin.json` 不是合法 JSON，请删除根目录副本。");
    }
  }
  return manifests[0].data;
}

/**
 * 收录前对安装包做一次完整扫描，三类规则都跑。
 * 主程序包清单取不到就只跳过依赖这一类——那时候所有自带包都会被当成第三方，
 * 报出来全是噪音；静态扫描和恶意特征扫描照查，不依赖那份清单。
 */
async function scanSubmission(workDir: string, zipPath: string, notes: string[]): Promise<ScanReport | null> {
  const hostPackages = await loadHostPackages(workDir, () => {});
  const checks: ScanCheck[] = ["static", "malware"];
  if (hostPackages.length > 0) checks.unshift("dependency");
  else notes.push("主程序自带包清单没取到，这次没查第三方依赖，其余检查照做了。");
  const knownPlugins = (await readdir(pluginsDir).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
  try {
    return await scanZip(zipPath, { checks, hostPackages, knownPlugins });
  } catch (error) {
    notes.push(`安全扫描没跑起来（${errorMessage(error).slice(0, 160)}），合并前请自己看一下源码。`);
    return null;
  }
}

/** 扫描结论分两段列：确定的问题要改，其余的合并前确认一下 */
function scanSection(scan: ScanReport | null | undefined): string[] {
  if (!scan) return [];
  const blocks = findingLines(scan, "block");
  const reviews = findingLines(scan, "review");
  if (blocks.length + reviews.length === 0) return [];
  return [
    ...(blocks.length > 0 ? ["**扫描：必须处理**", "", ...blocks.map((line) => `- ${line}`), ""] : []),
    ...(reviews.length > 0 ? ["**扫描：需要确认**", "", ...reviews.map((line) => `- ${line}`), ""] : []),
    `扫描覆盖：${describeScan(scan)}。`
  ];
}

/** 三类扫描在摘要里的名字，与 Python 侧的 category 对应 */
const SCAN_CATEGORIES: [string, string][] = [
  ["static", "static calls"],
  ["dependency", "third-party deps"],
  ["virus", "malware"]
];

/**
 * 运行摘要：校验结论和三类扫描各命中多少，写进 Actions 的 Summary。
 * issue 评论只在有命中时才提扫描，这条用来回答「到底扫过没有、扫出什么」
 */
async function writeStepSummary(issue: Issue, check: SubmissionCheck): Promise<void> {
  const summary = new StepSummary(`#${issue.number} ${issue.title}`);
  if (check.errors.length > 0 || !check.entry || !check.preview) {
    summary.paragraph("**Check failed**").bullets(check.errors);
  } else {
    summary.paragraph("**Check passed**");
  }

  summary.section("Scan");
  const scan = check.scan;
  if (!scan) {
    summary.bullets(["not run, see job log"]);
  } else {
    const counts = SCAN_CATEGORIES.map(([category, label]) => {
      const count = (severity: "block" | "review") =>
        scan.findings.filter((item) => item.category === category && item.severity === severity).length;
      const parts = [
        count("block") > 0 ? `${count("block")} to fix` : "",
        count("review") > 0 ? `${count("review")} to review` : ""
      ].filter(Boolean);
      return `${label}: ${parts.length > 0 ? parts.join(", ") : "none"}`;
    });
    counts.push(`scope: ${scan.scannedFiles} files scanned (${scan.pythonFiles} Python)`);
    summary.bullets(counts);
  }

  await summary.write();
}

/**
 * 校验一条收录申请。
 * 只读 GitHub 和本地数据仓，除了在临时目录里下载附件、写一份主程序包清单快照，不写任何东西：
 * 通过就返回待提交的条目、预览表格和扫描结论，不通过就把原因堆进 errors。发 PR、打标签那些是调用方的事。
 * 扫描结论不参与这个判定 —— 它只写进评论给维护者看，拦不拦由人决定。
 */
export async function checkSubmission(
  issue: Issue,
  policy: MarketPolicy,
  workDir: string
): Promise<SubmissionCheck> {
  const errors: string[] = [];
  const notes: string[] = [];
  const body = issue.body ?? "";
  const login = issue.user.login;

  const target = parseRepoUrl(body);
  if (!target) return { errors: ["正文中没有找到 `https://github.com/<owner>/<repo>` 格式的仓库地址。"], notes };

  const repo = await orNull(github<GhRepo>(`/repos/${target.owner}/${target.name}`));
  if (!repo || repo.private) return { errors: [`仓库 \`${target.owner}/${target.name}\` 不存在或不是公开仓库。`], notes };
  if (repo.archived) errors.push("仓库已归档（archived）。");
  if (policy.bannedRepoIds.includes(repo.id) || policy.bannedUsers.includes(repo.owner.login)) {
    return { errors: ["该仓库或其所有者已被禁止提交。"], notes };
  }

  if (repo.owner.type === "User") {
    if (repo.owner.login.toLowerCase() !== login.toLowerCase()) {
      errors.push(`提交者必须是仓库所有者：仓库属于 \`${repo.owner.login}\`，提交者是 \`${login}\`。`);
    }
  } else {
    notes.push(`组织仓库：请维护者确认 \`${login}\` 对 \`${repo.full_name}\` 有管理权限。`);
  }

  const tags = parseTags(body);
  if (tags.length > MAX_TAGS || tags.some((tag) => !TAG_PATTERN.test(tag))) {
    errors.push(`标签最多 ${MAX_TAGS} 个，只能包含小写字母、数字和 \`-\`：${tags.join(", ")}`);
  }

  const manifest = await findPackageManifest(repo, errors, notes);
  if (!manifest) return { errors, notes };
  const id = String(manifest.id ?? "");
  if (!ID_PATTERN.test(id)) return { errors: [...errors, `插件 ID \`${id}\` 不符合 \`^[a-z][a-z0-9_]*$\`。`], notes };
  if (policy.reservedIds.includes(id)) errors.push(`插件 ID \`${id}\` 是保留 ID。`);

  const entryPath = join(pluginsDir, `${id}.json`);
  if (existsSync(entryPath)) {
    const existing = JSON.parse(await readFile(entryPath, "utf-8")) as MarketSourceEntry;
    errors.push(
      existing.repoId === repo.id
        ? `插件 \`${id}\` 已收录，新版本发布后会自动同步，无需重复提交。`
        : `插件 ID \`${id}\` 已被其他仓库占用；如需转移请提交 \`[transfer]\` Issue。`
    );
  }

  const release = await checkLatestRelease(repo.full_name, id, policy, workDir);
  errors.push(...release.errors);
  if (errors.length > 0 || !release.release || !release.check || !release.zipPath) return { errors, notes };

  // 扫描结论只进评论，不进 errors：它说明这个包有什么问题，收录与否仍由自动校验和维护者决定
  const scan = await scanSubmission(workDir, release.zipPath, notes);

  const zipManifest = release.check.result.manifest;
  const entry: MarketSourceEntry = {
    id,
    repo: repo.full_name,
    repoId: repo.id,
    tags,
    extraRisk: [],
    status: "listed",
    pinned: false,
    review: { issue: issue.number, submittedBy: login }
  };
  const preview = [
    "| 字段 | 值 |",
    "| --- | --- |",
    `| 插件 ID | \`${id}\` |`,
    `| 名称 | ${String(zipManifest.name)} |`,
    `| 简介 | ${String(zipManifest.summary)} |`,
    `| 仓库 | [${repo.full_name}](${repo.html_url})（repoId ${repo.id}） |`,
    `| 版本 | \`${release.release.tag_name}\`（versionCode ${String(zipManifest.versionCode)}${release.release.prerelease ? "，beta" : ""}） |`,
    `| 风险标签 | ${((zipManifest.risk as string[]) ?? []).map((risk) => `\`${risk}\``).join(" ") || "无"} |`,
    `| 附件 | \`${id}.zip\` ${release.check.size} bytes |`,
    `| sha256 | \`${release.check.sha256}\` |`,
    `| 不可变 Release | ${release.release.immutable ? "是" : "否"} |`,
    `| 标签 | ${tags.join(", ") || "无"} |`
  ].join("\n");
  return { errors, notes, entry, preview, scan };
}

function base64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

/** 校验通过后才调用：写条目文件、开 PR、打标签，全程只碰 ctx 绑好的那个仓库 */
export async function openPullRequest(ctx: BotContext, issue: Issue, check: ReadyCheck): Promise<void> {
  const entry = check.entry;
  const branch = `submission/${entry.id}`;
  const owner = ctx.marketRepo.split("/")[0];
  // 扫描结论跟着收录结论一起说，不另开 issue；命中了也不拦 PR
  const scanLines = scanSection(check.scan);
  const open = await github<{ number: number }[]>(
    `/repos/${ctx.marketRepo}/pulls?state=open&head=${owner}:${branch}`
  );
  if (open.length > 0) {
    await ctx.comment(
      issue.number,
      [`插件 \`${entry.id}\` 已有审核中的 PR #${open[0].number}，请等待维护者处理。`, ...(scanLines.length > 0 ? ["", ...scanLines] : [])].join("\n")
    );
    return;
  }

  const base = await github<{ object: { sha: string } }>(
    `/repos/${ctx.marketRepo}/git/ref/heads/${ctx.baseBranch}`
  );
  try {
    await github(`/repos/${ctx.marketRepo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: base.object.sha }
    });
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
    await github(`/repos/${ctx.marketRepo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: { sha: base.object.sha, force: true }
    });
  }

  const path = `market/plugins/${entry.id}.json`;
  const message = [
    `feat: 收录 ${entry.id} 插件`,
    "",
    `Submitted-By: ${entry.review.submittedBy}`,
    `Submission-Issue: #${issue.number}`,
    `Repo: ${entry.repo}`,
    `Repo-Id: ${entry.repoId}`
  ].join("\n");
  const first = await github<{ content: { sha: string } }>(`/repos/${ctx.marketRepo}/contents/${path}`, {
    method: "PUT",
    body: { message, content: base64(formatEntry(entry)), branch }
  });

  const prBody = [
    `由提交机器人根据 #${issue.number} 生成，自动校验已通过，等待维护者审核。`,
    "",
    check.preview,
    "",
    ...(check.notes.length > 0 ? ["**需要人工确认**", "", ...check.notes.map((note) => `- ${note}`), ""] : []),
    ...(scanLines.length > 0 ? [scanLines.join("\n"), ""] : []),
    "**审核清单**",
    "",
    "- [ ] README 说明清楚功能和使用方式",
    "- [ ] 风险标签与实际行为一致（必要时在 `extraRisk` 追加）",
    "- [ ] 源码中没有混淆、下载执行远程代码或与功能无关的行为",
    "- [ ] 标签合适",
    "",
    `Closes #${issue.number}`
  ].join("\n");
  const pr = await github<{ number: number; html_url: string }>(`/repos/${ctx.marketRepo}/pulls`, {
    method: "POST",
    body: { title: `feat: 收录 ${entry.id} 插件`, head: branch, base: ctx.baseBranch, body: prBody }
  });

  entry.review.pr = pr.number;
  const second = await github<{ commit: { sha: string } }>(`/repos/${ctx.marketRepo}/contents/${path}`, {
    method: "PUT",
    body: {
      message: `chore: 记录 ${entry.id} 的审核 PR #${pr.number}`,
      content: base64(formatEntry(entry)),
      branch,
      sha: first.content.sha
    }
  });
  await github(`/repos/${ctx.marketRepo}/statuses/${second.commit.sha}`, {
    method: "POST",
    body: { state: "success", context: "market/validate", description: "Submission bot validated the release asset" }
  });
  await ctx.addLabels(pr.number, ["submission"]);
  await ctx.addLabels(issue.number, ["pending"]);
  await ctx.comment(
    issue.number,
    [
      `校验通过，已创建 PR #${pr.number}，等待维护者审核。合并后插件会在几分钟内出现在网站上。`,
      ...(scanLines.length > 0 ? ["", ...scanLines] : [])
    ].join("\n")
  );
}

// ---- 启动 ----

run(main);

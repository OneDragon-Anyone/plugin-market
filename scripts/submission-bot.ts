import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketPolicy, MarketSourceEntry } from "../src/lib/types";
import { GitHubError, type GhRepo, github, orNull } from "./lib/github";
import { formatEntry, ID_PATTERN, MAX_TAGS, pluginsDir, readPolicy, TAG_PATTERN } from "./lib/market";
import { checkLatestRelease } from "./lib/validator";

const marketRepo = process.env.GITHUB_REPOSITORY ?? "";
const baseBranch = process.env.MARKET_BASE_BRANCH ?? "master";
const siteUrl = process.env.MARKET_SITE_URL ?? "";
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const PREFIX = /^\s*\[(submission|transfer|report|appeal)\]/i;

const LABELS: Record<string, { color: string; description: string }> = {
  submission: { color: "1d76db", description: "插件收录申请" },
  pending: { color: "fbca04", description: "校验通过，等待维护者审核 PR" },
  approved: { color: "0e8a16", description: "已收录" },
  rejected: { color: "d93f0b", description: "校验未通过或审核拒绝" },
  "needs-review": { color: "c5def5", description: "需要维护者人工确认后才会处理" },
  spam: { color: "000000", description: "格式不符的 Issue" },
  transfer: { color: "5319e7", description: "插件转移申请" },
  report: { color: "b60205", description: "插件举报" },
  appeal: { color: "bfd4f2", description: "申诉" },
  stale: { color: "cccccc", description: "插件仓库长期无法访问" }
};

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string; type: string };
  labels: { name: string }[];
  pull_request?: unknown;
}

interface PullRequest {
  number: number;
  merged: boolean;
  body: string | null;
  head: { ref: string; repo: { full_name: string } | null };
}

let labelsReady = false;

async function ensureLabels(): Promise<void> {
  if (labelsReady) return;
  for (const [name, label] of Object.entries(LABELS)) {
    try {
      await github(`/repos/${marketRepo}/labels`, { method: "POST", body: { name, ...label } });
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422)) throw error;
    }
  }
  labelsReady = true;
}

async function addLabels(issue: number, labels: string[]): Promise<void> {
  await ensureLabels();
  await github(`/repos/${marketRepo}/issues/${issue}/labels`, { method: "POST", body: { labels } });
}

async function removeLabels(issue: number, labels: string[]): Promise<void> {
  for (const label of labels) {
    await orNull(github(`/repos/${marketRepo}/issues/${issue}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }));
  }
}

async function comment(issue: number, body: string): Promise<void> {
  await github(`/repos/${marketRepo}/issues/${issue}/comments`, { method: "POST", body: { body } });
}

async function closeIssue(issue: number, reason: "completed" | "not_planned"): Promise<void> {
  await github(`/repos/${marketRepo}/issues/${issue}`, { method: "PATCH", body: { state: "closed", state_reason: reason } });
}

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

async function overRateLimit(login: string, policy: MarketPolicy): Promise<boolean> {
  const since = new Date(Date.now() - policy.rateLimit.windowHours * 3_600_000).toISOString().slice(0, 19);
  const query = `repo:${marketRepo} is:issue author:${login} "[submission]" in:title created:>=${since}`;
  const result = await github<{ total_count: number }>(`/search/issues?q=${encodeURIComponent(query)}`);
  return result.total_count > policy.rateLimit.maxOpenSubmissionsPerUser;
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

async function readManifestFile(fullName: string, path: string, ref: string): Promise<Record<string, unknown>> {
  const file = await github<{ content: string }>(
    `/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`
  );
  return JSON.parse(Buffer.from(file.content, "base64").toString("utf-8")) as Record<string, unknown>;
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
      manifests.push({ dir: dir.name, data: JSON.parse(Buffer.from(file.content, "base64").toString("utf-8")) });
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

interface SubmissionCheck {
  errors: string[];
  notes: string[];
  entry?: MarketSourceEntry;
  preview?: string;
}

async function checkSubmission(issue: Issue, policy: MarketPolicy, workDir: string): Promise<SubmissionCheck> {
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
  if (errors.length > 0 || !release.release || !release.check) return { errors, notes };

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
  return { errors, notes, entry, preview };
}

function base64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

async function openPullRequest(issue: Issue, check: Required<Pick<SubmissionCheck, "entry" | "preview">> & SubmissionCheck) {
  const entry = check.entry;
  const branch = `submission/${entry.id}`;
  const owner = marketRepo.split("/")[0];
  const open = await github<{ number: number }[]>(`/repos/${marketRepo}/pulls?state=open&head=${owner}:${branch}`);
  if (open.length > 0) {
    await comment(issue.number, `插件 \`${entry.id}\` 已有审核中的 PR #${open[0].number}，请等待维护者处理。`);
    return;
  }

  const base = await github<{ object: { sha: string } }>(`/repos/${marketRepo}/git/ref/heads/${baseBranch}`);
  try {
    await github(`/repos/${marketRepo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: base.object.sha }
    });
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
    await github(`/repos/${marketRepo}/git/refs/heads/${branch}`, {
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
  const first = await github<{ content: { sha: string } }>(`/repos/${marketRepo}/contents/${path}`, {
    method: "PUT",
    body: { message, content: base64(formatEntry(entry)), branch }
  });

  const prBody = [
    `由提交机器人根据 #${issue.number} 生成，自动校验已通过，等待维护者审核。`,
    "",
    check.preview,
    "",
    ...(check.notes.length > 0 ? ["**需要人工确认**", "", ...check.notes.map((note) => `- ${note}`), ""] : []),
    "**审核清单**",
    "",
    "- [ ] README 说明清楚功能和使用方式",
    "- [ ] 风险标签与实际行为一致（必要时在 `extraRisk` 追加）",
    "- [ ] 源码中没有混淆、下载执行远程代码或与功能无关的行为",
    "- [ ] 标签合适",
    "",
    `Closes #${issue.number}`
  ].join("\n");
  const pr = await github<{ number: number; html_url: string }>(`/repos/${marketRepo}/pulls`, {
    method: "POST",
    body: { title: `feat: 收录 ${entry.id} 插件`, head: branch, base: baseBranch, body: prBody }
  });

  entry.review.pr = pr.number;
  const second = await github<{ commit: { sha: string } }>(`/repos/${marketRepo}/contents/${path}`, {
    method: "PUT",
    body: {
      message: `chore: 记录 ${entry.id} 的审核 PR #${pr.number}`,
      content: base64(formatEntry(entry)),
      branch,
      sha: first.content.sha
    }
  });
  await github(`/repos/${marketRepo}/statuses/${second.commit.sha}`, {
    method: "POST",
    body: { state: "success", context: "market/validate", description: "Submission bot validated the release asset" }
  });
  await addLabels(pr.number, ["submission"]);
  await addLabels(issue.number, ["pending"]);
  await comment(issue.number, `校验通过，已创建 PR #${pr.number}，等待维护者审核。合并后插件会在几分钟内出现在网站上。`);
}

async function handleSubmission(issue: Issue, policy: MarketPolicy, trigger: "opened" | "edited" | "recheck", byMaintainer: boolean) {
  const labels = new Set(issue.labels.map((label) => label.name));
  if (labels.has("approved") || labels.has("spam")) return;
  if (trigger === "edited" && labels.has("pending")) return;
  if (labels.has("needs-review") && !byMaintainer) {
    if (trigger === "recheck") await comment(issue.number, "该提交需要维护者确认，维护者回复 `/recheck` 后会继续处理。");
    return;
  }

  await addLabels(issue.number, ["submission"]);
  if (policy.bannedUsers.includes(issue.user.login)) {
    await addLabels(issue.number, ["rejected"]);
    await comment(issue.number, "该账号已被禁止提交插件。如有异议请提交 `[appeal]` Issue。");
    await closeIssue(issue.number, "not_planned");
    return;
  }
  if (trigger === "opened" && (await overRateLimit(issue.user.login, policy))) {
    await addLabels(issue.number, ["needs-review"]);
    await comment(
      issue.number,
      `${policy.rateLimit.windowHours} 小时内提交超过 ${policy.rateLimit.maxOpenSubmissionsPerUser} 次，已转为人工处理。维护者确认后会回复 \`/recheck\`。`
    );
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "zzzod-submission-"));
  try {
    const check = await checkSubmission(issue, policy, workDir);
    if (check.errors.length > 0 || !check.entry || !check.preview) {
      await removeLabels(issue.number, ["pending"]);
      await addLabels(issue.number, ["rejected"]);
      await comment(
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
    await removeLabels(issue.number, ["rejected", "needs-review"]);
    await openPullRequest(issue, { ...check, entry: check.entry, preview: check.preview });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function triggerBuild(issue: Issue): Promise<void> {
  await github(`/repos/${marketRepo}/actions/workflows/build-market.yml/dispatches`, {
    method: "POST",
    body: { ref: baseBranch }
  });
  let runUrl = "";
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const runs = await github<{ workflow_runs: { html_url: string }[] }>(
      `/repos/${marketRepo}/actions/workflows/build-market.yml/runs?event=workflow_dispatch&per_page=1`
    );
    runUrl = runs.workflow_runs[0]?.html_url ?? "";
  } catch {
    // 查询运行链接失败不影响触发结果
  }
  await comment(issue.number, `已触发立即构建${runUrl ? `：${runUrl}` : ""}。站点与 API 会在几分钟后更新。`);
}

async function handleIssue(issue: Issue, trigger: "opened" | "edited" | "reopened" | "recheck", byMaintainer: boolean) {
  if (issue.pull_request || issue.user.type === "Bot") return;
  const match = PREFIX.exec(issue.title);
  if (!match) {
    if (trigger !== "opened") return;
    await addLabels(issue.number, ["spam"]);
    await comment(
      issue.number,
      `标题缺少 \`[submission]\` / \`[transfer]\` / \`[report]\` / \`[appeal]\` 前缀，已自动关闭。请通过${siteUrl ? `[插件仓库网站](${siteUrl}) 或` : ""} Issue 模板重新提交。`
    );
    await closeIssue(issue.number, "not_planned");
    await github(`/repos/${marketRepo}/issues/${issue.number}/lock`, { method: "PUT", body: { lock_reason: "spam" } });
    return;
  }

  const kind = match[1].toLowerCase();
  if (kind !== "submission") {
    if (trigger === "opened") {
      await addLabels(issue.number, [kind]);
      await comment(issue.number, "已收到，维护者会尽快处理。");
    }
    return;
  }
  const policy = await readPolicy();
  await handleSubmission(issue, policy, trigger === "reopened" ? "recheck" : trigger, byMaintainer);
}

async function handleClosedPullRequest(pr: PullRequest): Promise<void> {
  if (pr.head.repo?.full_name !== marketRepo || !pr.head.ref.startsWith("submission/")) return;
  const issueMatch = /Closes #(\d+)/.exec(pr.body ?? "");
  if (issueMatch) {
    const issue = Number(issueMatch[1]);
    await removeLabels(issue, ["pending"]);
    if (pr.merged) {
      await addLabels(issue, ["approved"]);
      await comment(issue, `PR #${pr.number} 已合并，插件已收录。之后发布新 Release 会自动同步。`);
      await closeIssue(issue, "completed");
    } else {
      await addLabels(issue, ["rejected"]);
      await comment(issue, `PR #${pr.number} 被关闭且未合并，原因请查看 PR 中维护者的说明。如有异议请提交 \`[appeal]\` Issue。`);
      await closeIssue(issue, "not_planned");
    }
  }
  await orNull(github(`/repos/${marketRepo}/git/refs/heads/${pr.head.ref}`, { method: "DELETE" })).catch(() => null);
}

async function main(): Promise<void> {
  if (!marketRepo) throw new Error("GITHUB_REPOSITORY is required");
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf-8"));

  if (eventName === "issues" && ["opened", "edited", "reopened"].includes(event.action)) {
    await handleIssue(event.issue as Issue, event.action, false);
  } else if (eventName === "issue_comment" && event.action === "created") {
    const issue = event.issue as Issue;
    const body = String(event.comment.body ?? "").trim();
    const byMaintainer = MAINTAINER_ASSOCIATIONS.has(event.comment.author_association);
    const byAuthor = event.comment.user.login === issue.user.login;
    if (body === "/recheck" && issue.state === "open" && (byMaintainer || byAuthor)) {
      await handleIssue(issue, "recheck", byMaintainer);
    } else if (body === "/sync" && (byMaintainer || byAuthor)) {
      await triggerBuild(issue);
    }
  } else if (eventName === "pull_request_target" && event.action === "closed") {
    await handleClosedPullRequest(event.pull_request as PullRequest);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

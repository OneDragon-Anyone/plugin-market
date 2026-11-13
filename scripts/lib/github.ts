/** GitHub REST 客户端与 issue / 标签写操作：token、错误类型、分页、标签表。 */



// ---- REST 客户端 ----

const API = "https://api.github.com";
const USER_AGENT = "zzzod-plugin-market";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  accept?: string;
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? "GET";
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const response = await fetch(path.startsWith("https://") ? path : `${API}${path}`, {
    method,
    headers: {
      Accept: options.accept ?? "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new GitHubError(response.status, `${method} ${path} -> ${response.status} ${text}`);
  }
  return response;
}

export async function github<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(path, options);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function githubText(path: string, accept: string): Promise<string> {
  return (await request(path, { accept })).text();
}

export async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

export interface GhOwner {
  login: string;
  type: "User" | "Organization";
  html_url: string;
}

export interface GhRepo {
  id: number;
  full_name: string;
  html_url: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  default_branch: string;
  stargazers_count: number;
  owner: GhOwner;
}

export interface GhAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  download_count: number;
  browser_download_url: string;
  digest?: string | null;
}

export interface GhRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  immutable?: boolean;
  created_at: string;
  published_at: string | null;
  body_html?: string;
  assets: GhAsset[];
}

/**
 * 附件内容摘要：GitHub 直接给 sha256，不用下载就能比对。
 * 老附件没有这个字段，返回 null 表示比不了。
 */
export function assetDigest(asset: GhAsset): string | null {
  const digest = asset.digest ?? "";
  return /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.slice(7).toLowerCase() : null;
}

export async function listReleases(fullName: string): Promise<GhRelease[]> {
  const releases = await github<GhRelease[]>(`/repos/${fullName}/releases?per_page=50`, {
    accept: "application/vnd.github.html+json"
  });
  return releases.filter((release) => !release.draft && release.tag_name.startsWith("v"));
}

export async function resolveTagCommit(fullName: string, tag: string): Promise<string> {
  const commit = await github<{ sha: string }>(`/repos/${fullName}/commits/${encodeURIComponent(tag)}`);
  return commit.sha;
}

export async function downloadBytes(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!response.ok) throw new Error(`download ${url} -> ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error(`asset is ${declared} bytes, limit ${maxBytes}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`asset is ${data.length} bytes, limit ${maxBytes}`);
  return data;
}

// ---- 标签与 issue 写操作 ----

/**
 * 仓库用到的标签，一处定义。
 * 提交机器人靠它建标签、打标签，构建流程开自动 issue 时也用它，
 * 免得同一个标签两边各写一份，改了一处忘了另一处。
 */
export const LABELS: Record<string, { color: string; description: string }> = {
  submission: { color: "1d76db", description: "插件收录申请" },
  pending: { color: "fbca04", description: "校验通过，等待维护者审核 PR" },
  approved: { color: "0e8a16", description: "已收录" },
  rejected: { color: "d93f0b", description: "校验未通过或审核拒绝" },
  "needs-review": { color: "c5def5", description: "需要维护者人工确认后才会处理" },
  spam: { color: "000000", description: "格式不符的 Issue" },
  transfer: { color: "5319e7", description: "插件转移申请" },
  report: { color: "b60205", description: "插件举报" },
  appeal: { color: "bfd4f2", description: "申诉" },
  stale: { color: "cccccc", description: "插件仓库长期无法访问" },
  revoked: { color: "e99695", description: "已收录版本的安装包与市场记录不一致" }
};

/** 已存在的标签 GitHub 返回 422，当成功处理 */
async function ensureLabel(repo: string, name: string): Promise<void> {
  try {
    await github(`/repos/${repo}/labels`, { method: "POST", body: { name, ...LABELS[name] } });
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
  }
}

/** 开 issue 前先把要用的标签备好，不然带上不存在的标签会被拒 */
export async function ensureLabels(repo: string, names: string[]): Promise<void> {
  for (const name of names) await ensureLabel(repo, name);
}

export interface IssueDraft {
  title: string;
  body: string;
  /** 顺带打上的标签 不存在会先建出来 */
  labels?: string[];
}

/** 开一条新 issue 返回编号 */
export async function openIssue(repo: string, draft: IssueDraft): Promise<number> {
  if (draft.labels?.length) await ensureLabels(repo, draft.labels);
  const issue = await github<{ number: number }>(`/repos/${repo}/issues`, { method: "POST", body: draft });
  return issue.number;
}

/** 往已有 issue 补一条评论 失败就抛出 */
export async function commentIssue(repo: string, issue: number, body: string): Promise<void> {
  await github(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: { body } });
}

/**
 * 往一条可能已经不存在的 issue 补评论。
 * 返回 false 只代表这条 issue 被删了 —— 关掉的照样能评论，关闭不等于问题解决。
 */
export async function tryCommentIssue(repo: string, issue: number, body: string): Promise<boolean> {
  return (await orNull(commentIssue(repo, issue, body))) !== null;
}

/** 关闭 issue 带 reason 时 GitHub 会记下关闭原因 */
export async function closeIssue(repo: string, issue: number, reason?: "completed" | "not_planned"): Promise<void> {
  await github(`/repos/${repo}/issues/${issue}`, {
    method: "PATCH",
    body: reason ? { state: "closed", state_reason: reason } : { state: "closed" }
  });
}

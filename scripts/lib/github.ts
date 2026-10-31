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

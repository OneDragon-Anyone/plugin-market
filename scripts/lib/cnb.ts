import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { blake2b } from "blakejs";
import type { MarketPolicy } from "../../src/lib/types";

const DEFAULT_API = "https://api.cnb.cool";
const SITE_ROOT = "https://cnb.cool";
const PYPI_ROOT = "https://pypi.cnb.cool";
const USER_AGENT = "zzzod-plugin-market";
const runGit = promisify(execFile);

export class CnbError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface MirrorTarget {
  /** 索引与封面同步到的仓库 */
  repo: string;
  /** 安装包存放的 PyPI 制品库 形如 组织名称/制品库名称 */
  registry: string;
  /** 制品库站点 形如 https://pypi.cnb.cool */
  registrySite: string;
  token: string;
  api: string;
  branch: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function request(
  target: MirrorTarget,
  path: string,
  options: RequestOptions = {}
): Promise<Response> {
  const method = options.method ?? "GET";
  const url = /^https?:\/\//i.test(path) ? path : `${target.api}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.cnb.api+json",
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${target.token}`,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new CnbError(response.status, `${method} ${path} -> ${response.status} ${text}`);
  }
  return response;
}

async function cnb<T>(target: MirrorTarget, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(target, path, options);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** 取第一个非空值 工作流里没配的 secret 是空串 只判断 ?? 会漏掉回落 */
function envValue(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function registrySiteOf(api: string): string {
  const configured = envValue(process.env.CNB_PYPI_ENDPOINT);
  if (configured !== "") return configured.replace(/\/+$/, "");
  return api === DEFAULT_API ? PYPI_ROOT : "";
}

export function readMirrorTarget(policy: MarketPolicy): MirrorTarget | null {
  const mirror = policy.mirror;
  if (mirror === undefined || !mirror.enabled) return null;

  const repo = envValue(process.env.CNB_MIRROR_REPO, mirror.repo);
  const registry = envValue(process.env.CNB_PYPI_REPO, mirror.pypi);
  const token = envValue(process.env.CNB_PYPI_TOKEN, process.env.CNB_TOKEN);
  if (repo === "" || registry === "" || token === "") return null;

  const api = envValue(process.env.CNB_API_ENDPOINT, mirror.api, DEFAULT_API).replace(/\/+$/, "");
  const registrySite = registrySiteOf(api);
  if (registrySite === "") return null;

  return {
    repo,
    registry,
    registrySite,
    token,
    api,
    branch: envValue(process.env.CNB_MIRROR_BRANCH, mirror.branch, "main")
  };
}

export const INDEX_FILE = "plugins.json";

function siteUrlOf(target: MirrorTarget): string {
  return target.api === DEFAULT_API ? SITE_ROOT : target.api;
}

function redact(text: string, token: string): string {
  return text.split(token).join("***").split(encodeURIComponent(token)).join("***");
}

/** PyPI 只接受 PEP 440 版本号 不合规时退回 versionCode 保证仍能镜像 */
const PEP440 = /^\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?$/i;

export function packageVersion(version: string, versionCode: number): string {
  return PEP440.test(version) ? version : String(versionCode);
}

function digests(data: Buffer): Record<string, string> {
  return {
    md5: createHash("md5").update(data).digest("hex"),
    sha256: createHash("sha256").update(data).digest("hex"),
    blake2: Buffer.from(blake2b(new Uint8Array(data), undefined, 32)).toString("hex")
  };
}

/**
 * 制品库只接受 multipart 表单上传 且必须带 blake2b-256 摘要
 * 同版本重复上传是幂等的 内容不会重复堆积
 */
async function uploadPackage(target: MirrorTarget, id: string, pver: string, data: Buffer): Promise<void> {
  const hash = digests(data);
  const form = new FormData();
  form.set(":action", "file_upload");
  form.set("protocol_version", "1");
  form.set("name", id);
  form.set("version", pver);
  form.set("filetype", "sdist");
  form.set("pyversion", "source");
  form.set("metadata_version", "2.1");
  form.set("summary", `${id} 插件安装包`);
  form.set("md5_digest", hash.md5);
  form.set("sha256_digest", hash.sha256);
  form.set("blake2_256_digest", hash.blake2);
  form.set("content", new Blob([new Uint8Array(data)], { type: "application/zip" }), `${id}-${pver}.zip`);

  const auth = Buffer.from(`cnb:${target.token}`).toString("base64");
  const response = await fetch(`${target.registrySite}/${target.registry}/-/packages/simple`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Authorization: `Basic ${auth}` },
    body: form
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new CnbError(response.status, `上传 ${id}-${pver}.zip -> ${response.status} ${text}`);
  }
}

export interface PackageFile {
  name: string;
  url: string;
  /** simple 索引里附带的摘要 用来核对上传的是不是同一份字节 */
  sha256: string | null;
}

/** 解析 simple 索引 文件地址带内容摘要 只能读回来不能自己拼 */
async function packageFiles(target: MirrorTarget, id: string): Promise<PackageFile[]> {
  const indexUrl = `${target.registrySite}/${target.registry}/-/packages/simple/${encodeURIComponent(id)}/`;
  const response = await fetch(indexUrl, { headers: { "User-Agent": USER_AGENT } });
  if (response.status === 404) return [];
  if (!response.ok) throw new CnbError(response.status, `读取 ${id} 索引失败：${response.status}`);

  const html = await response.text();
  const files: PackageFile[] = [];
  for (const match of html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
    const [href, fragment] = match[1].split("#");
    files.push({
      name: decodeURIComponent(match[2].trim()),
      url: new URL(href, indexUrl).toString(),
      sha256: fragment?.startsWith("sha256=") ? fragment.slice(7) : null
    });
  }
  return files;
}

/** 制品库当前还留着哪些文件 读不到时返回 null 交给调用方决定要不要沿用上一次的地址 */
export async function readPackageFiles(target: MirrorTarget, id: string): Promise<PackageFile[] | null> {
  try {
    return await packageFiles(target, id);
  } catch {
    return null;
  }
}

/**
 * 把安装包发到制品库 客户端从这里下载 国内不需要经过 GitHub
 *
 * 制品库提供完整的下载统计 所以索引里的下载量能把两个源合起来算
 *
 * 旧版本由制品库自己的清理策略处理 这里只管上传 删多了也不会留下悬空地址
 */
export async function publishMirrorPackage(
  target: MirrorTarget,
  id: string,
  version: string,
  versionCode: number,
  zipPath: string,
  expectSha256: string
): Promise<string> {
  const pver = packageVersion(version, versionCode);
  const fileName = `${id}-${pver}.zip`;
  const data = await readFile(zipPath);

  await uploadPackage(target, id, pver, data);

  // 同一个包下按版本取名匹配 取不到时退回按摘要匹配 保证拿到的是刚上传的那份
  const files = await packageFiles(target, id);
  const file = files.find((item) => item.name === fileName) ?? files.find((item) => item.sha256 === expectSha256);
  if (file === undefined) throw new Error(`制品库未能查到 ${fileName}`);
  if (file.sha256 !== null && file.sha256 !== expectSha256) {
    throw new Error(`制品校验值不一致：期望 ${expectSha256}，实际 ${file.sha256}`);
  }
  return file.url;
}

/** 制品库的下载总量 读不到字段时返回 null 由调用方沿用上一次的数字 */
export async function readPackageDownloads(target: MirrorTarget, id: string): Promise<number | null> {
  try {
    const data = await cnb<{ pypi?: { pull_count?: number } }>(
      target,
      `/${target.registry}/-/packages/pypi/${encodeURIComponent(id)}`
    );
    const pulled = data?.pypi?.pull_count;
    return typeof pulled === "number" && Number.isFinite(pulled) ? pulled : null;
  } catch {
    return null;
  }
}

/**
 * 把索引和封面作为普通文件提交到镜像仓，客户端用 raw 直链读取。
 *
 * 两个源的索引是同一份内容，内容没变就不提交，避免定时构建把仓库历史堆满。
 */
export async function publishIndexFile(
  target: MirrorTarget,
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
    // 封面跟索引放同级，客户端按「索引目录 + cover」拼地址；只保留本次构建的封面，旧版本图不残留
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

import { readFile } from "node:fs/promises";
import type { RegistryPolicy } from "../../src/lib/types";

const DEFAULT_API = "https://api.cnb.cool";
const SITE_ROOT = "https://cnb.cool";
const USER_AGENT = "zzzod-plugin-market";

export class CnbError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface MirrorTarget {
  repo: string;
  token: string;
  api: string;
  branch: string;
  tagPrefix: string;
  keepReleases: number;
}

export interface CnbAsset {
  id: string;
  name: string;
  size: number;
  browser_download_url?: string;
  hash_algo?: string;
  hash_value?: string;
}

export interface CnbRelease {
  id: string;
  tag_name: string;
  assets?: CnbAsset[];
}

interface UploadTicket {
  upload_url: string;
  verify_url: string;
  expires_in_sec?: number;
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
  // 上传票据返回的 upload_url / verify_url 是绝对地址，直接请求时不能再拼 api 前缀
  const url = /^https?:\/\//i.test(path) ? path : `${target.api}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
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

function isNotFound(error: unknown): boolean {
  return error instanceof CnbError && error.status === 404;
}

export function readMirrorTarget(policy: RegistryPolicy): MirrorTarget | null {
  const mirror = policy.mirror;
  if (mirror === undefined || !mirror.enabled) return null;

  const repo = (process.env.CNB_MIRROR_REPO ?? mirror.repo ?? "").trim();
  const token = (process.env.CNB_TOKEN ?? "").trim();
  if (repo === "" || token === "") return null;

  return {
    repo,
    token,
    api: (process.env.CNB_API_ENDPOINT ?? mirror.api ?? DEFAULT_API).trim().replace(/\/+$/, ""),
    branch: (process.env.CNB_MIRROR_BRANCH ?? mirror.branch ?? "main").trim(),
    tagPrefix: mirror.tagPrefix ?? "",
    keepReleases: mirror.keepReleases ?? policy.keepReleases
  };
}

export async function findRelease(target: MirrorTarget, tag: string): Promise<CnbRelease | null> {
  try {
    return await cnb<CnbRelease>(target, `/${target.repo}/-/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function createTag(target: MirrorTarget, tag: string, commitish: string): Promise<void> {
  try {
    await cnb(target, `/${target.repo}/-/git/tags`, {
      method: "POST",
      body: { name: tag, target: commitish, message: `mirror assets for ${tag}` }
    });
  } catch (error) {
    // tag 已存在时平台会返回错误，此时直接复用以它为源的 release
  }
}

export async function ensureRelease(
  target: MirrorTarget,
  tag: string,
  commitish: string
): Promise<CnbRelease> {
  const existing = await findRelease(target, tag);
  if (existing !== null) return existing;

  await createTag(target, tag, commitish);
  return await cnb<CnbRelease>(target, `/${target.repo}/-/releases`, {
    method: "POST",
    body: {
      tag_name: tag,
      name: tag,
      body: "插件安装包镜像，由 plugin-market 自动生成",
      target_commitish: commitish,
      draft: false,
      prerelease: false,
      make_latest: "false"
    }
  });
}

export function mirrorAssetName(id: string, versionCode: number): string {
  return `${id}-${versionCode}.zip`;
}

export function mirrorDownloadUrl(target: MirrorTarget, tag: string, assetName: string): string {
  const site = target.api === DEFAULT_API ? SITE_ROOT : target.api;
  return `${site}/${target.repo}/-/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

async function uploadAsset(
  target: MirrorTarget,
  releaseId: string,
  assetName: string,
  data: Buffer
): Promise<void> {
  const ticket = await cnb<UploadTicket>(target, `/${target.repo}/-/releases/${releaseId}/asset-upload-url`, {
    method: "POST",
    body: { asset_name: assetName, size: data.length, overwrite: true }
  });

  const upload = await fetch(ticket.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "application/zip", "User-Agent": USER_AGENT },
    body: new Uint8Array(data)
  });
  if (!upload.ok) {
    const text = (await upload.text()).slice(0, 300);
    throw new CnbError(upload.status, `PUT asset -> ${upload.status} ${text}`);
  }

  await request(target, ticket.verify_url, { method: "POST" });
}

export async function findAsset(
  target: MirrorTarget,
  releaseId: string,
  assetName: string
): Promise<CnbAsset | null> {
  const release = await cnb<CnbRelease>(target, `/${target.repo}/-/releases/${releaseId}`);
  return release.assets?.find((asset) => asset.name === assetName) ?? null;
}

async function deleteAsset(target: MirrorTarget, releaseId: string, assetId: string): Promise<void> {
  await request(target, `/${target.repo}/-/releases/${releaseId}/assets/${assetId}`, { method: "DELETE" });
}

export interface MirrorPublishResult {
  url: string;
  pruned: number;
}

export async function publishMirrorAsset(
  target: MirrorTarget,
  id: string,
  versionCode: number,
  zipPath: string,
  expectSha256: string
): Promise<MirrorPublishResult> {
  const releaseTag = `${target.tagPrefix}${id}`;
  const assetName = mirrorAssetName(id, versionCode);

  const release = await ensureRelease(target, releaseTag, target.branch);
  const data = await readFile(zipPath);
  await uploadAsset(target, release.id, assetName, data);

  const uploaded = await findAsset(target, release.id, assetName);
  if (uploaded === null) throw new Error(`镜像附件 ${assetName} 上传后未能查到`);
  if (uploaded.size !== data.length) {
    throw new Error(`镜像附件大小不一致：本地 ${data.length}，远端 ${uploaded.size}`);
  }
  if (uploaded.hash_value !== undefined && uploaded.hash_value.toLowerCase() !== expectSha256) {
    throw new Error(`镜像附件校验值不一致：期望 ${expectSha256}，实际 ${uploaded.hash_value}`);
  }

  const pruned = await pruneAssets(target, release.id, id, target.keepReleases);
  return { url: mirrorDownloadUrl(target, releaseTag, assetName), pruned };
}

async function pruneAssets(
  target: MirrorTarget,
  releaseId: string,
  id: string,
  keepReleases: number
): Promise<number> {
  const release = await cnb<CnbRelease>(target, `/${target.repo}/-/releases/${releaseId}`);
  const pattern = new RegExp(`^${id}-(\\d+)\\.zip$`);
  const owned = (release.assets ?? [])
    .map((asset) => ({ asset, code: Number(pattern.exec(asset.name)?.[1] ?? Number.NaN) }))
    .filter((item) => Number.isInteger(item.code))
    .sort((a, b) => b.code - a.code);

  for (const item of owned.slice(keepReleases)) {
    await deleteAsset(target, release.id, item.asset.id);
  }
  return Math.max(owned.length - keepReleases, 0);
}

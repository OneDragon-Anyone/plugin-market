/** 下载源规则：解析作者声明的镜像仓库，拼出各站点的安装包地址。 */



// ---- 镜像解析与下载地址 ----

/** 镜像只收这两家，作者填仓库地址，下载路径由构建拼 */
export type MirrorHost = "cnb" | "gitee";

export interface MirrorRepo {
  host: MirrorHost;
  origin: string;
  /** 仓库坐标，已解码（中文组名保持可读）；cnb 允许多级组，gitee 固定 owner/repo */
  repo: string;
}

/** 各家的仓库地址深度：cnb 允许多级组所以留空，gitee 固定 owner/repo 两层 */
const MIRROR_HOSTS: { host: MirrorHost; domain: string; depth?: number }[] = [
  { host: "cnb", domain: "cnb.cool" },
  { host: "gitee", domain: "gitee.com", depth: 2 }
];

/** 这些段只会出现在具体页面里，仓库地址本身没有，出现了说明贴的是整条链接 */
const PAGE_SEGMENTS = new Set(["-", "releases", "download", "tree", "blob"]);

/** 仓库路径的一段：字母、数字、组合符，以及 . _ ~ -；中文等非 ASCII 字母同样放行 */
const SEGMENT_PATTERN = /^[\p{L}\p{N}\p{M}._~-]+$/u;

/**
 * 把作者填的地址解析成镜像仓库。
 *
 * 只认 cnb.cool / gitee.com 的仓库首页本身：带查询串、锚点、非 https、路径层数不对，
 * 或者贴成了 releases / tree 这类具体页面，都不认，免得拼出来的下载地址打不开。
 *
 * 中文组名在 URL 里是百分号编码的，这里统一解码后再校验，`repo` 存可读形式。
 */
function parseMirrorRepo(raw: string): MirrorRepo | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") return null;
  const matched = MIRROR_HOSTS.find(({ domain }) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  if (matched === undefined) return null;

  let segments: string[];
  try {
    segments = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    // 残缺的百分号编码
    return null;
  }
  if (segments.length < 2) return null;
  // gitee 的仓库固定 owner/repo，多出来的段说明贴的不是仓库首页
  if (matched.depth !== undefined && segments.length !== matched.depth) return null;
  // 解码后的 `.` / `..` 会被客户端再规范化一次，拼出来的地址就跑到别的层级去了
  if (
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || !SEGMENT_PATTERN.test(segment) || PAGE_SEGMENTS.has(segment)
    )
  ) {
    return null;
  }
  return { host: matched.host, origin: url.origin, repo: segments.join("/") };
}

/** 一个镜像写字符串，两个写数组，其他形态都不认 */
function mirrorList(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
  return null;
}

/** 条目里的镜像解析成仓库列表；校验已拦过非法值，这里对解析不了的直接跳过 */
export function parseMirrors(value: unknown): MirrorRepo[] {
  return (mirrorList(value) ?? []).flatMap((raw) => parseMirrorRepo(raw) ?? []);
}

/** `mirror` 的形态与地址校验，错误交给调用方的 fail */
export function checkMirror(value: unknown, fail: (message: string) => void): void {
  const list = mirrorList(value);
  if (list === null) {
    fail("mirror must be a repo URL or a list of them");
    return;
  }
  if (list.length === 0) {
    fail("mirror must not be empty");
    return;
  }
  // cnb / gitee 各限一家，条数上限就是 host 数
  if (list.length > MIRROR_HOSTS.length) {
    fail("mirror takes at most one cnb and one gitee repo");
    return;
  }

  const hosts = new Set<MirrorHost>();
  for (const raw of list) {
    const repo = parseMirrorRepo(raw);
    if (repo === null) {
      fail(`mirror "${raw}" must be a cnb.cool / gitee.com repo URL, like https://cnb.cool/group/repo`);
    } else if (hosts.has(repo.host)) {
      fail(`mirror has more than one ${repo.host} repo`);
    } else {
      hosts.add(repo.host);
    }
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
export function githubAssetUrl(repo: string, tag: string, assetName: string): string {
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
export function buildSources(
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

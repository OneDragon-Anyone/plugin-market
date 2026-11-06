import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MarketPolicy } from "../../src/lib/types";

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

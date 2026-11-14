/** 插件包校验：下载 `<id>.zip`，起模板仓的 validate_plugin.py 过一遍。 */

import { downloadBytes, type GhRelease, listReleases } from "./github";
import { templateDir } from "./paths";
import { lastJsonLine, runPython } from "./python";
import { type MarketPolicy } from "@/lib/types";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---- 插件包校验 ----

export interface ValidatorResult {
  ok: boolean;
  errors: { code: string; detail: string }[];
  manifest: Record<string, unknown>;
  coverFile: string;
  hasAppSetting: boolean;
}

async function runValidator(args: string[]): Promise<ValidatorResult> {
  const script = join(templateDir, "scripts", "validate_plugin.py");
  const run = await runPython(script, [...args, "--json"]);
  const lastLine = run.stdout.trim().split("\n").pop() ?? "";
  if ((run.code !== 0 && run.code !== 1) || !lastLine.startsWith("{")) {
    throw new Error(`validator exited with ${run.code}: ${(run.stderr || run.stdout).trim()}`);
  }
  return lastJsonLine<ValidatorResult>(run.stdout, "validator");
}

export interface ZipCheck {
  result: ValidatorResult;
  sha256: string;
  size: number;
}

export async function downloadAndValidate(
  url: string,
  zipPath: string,
  options: { expectId: string; expectTag: string; policy: MarketPolicy; coverOut?: string }
): Promise<ZipCheck> {
  const data = await downloadBytes(url, options.policy.maxZipBytes);
  await writeFile(zipPath, data);
  const args = [
    "--zip",
    zipPath,
    "--expect-id",
    options.expectId,
    "--expect-tag",
    options.expectTag,
    "--max-zip-bytes",
    String(options.policy.maxZipBytes),
    "--max-cover-bytes",
    String(options.policy.maxCoverBytes)
  ];
  if (options.coverOut) args.push("--cover-out", options.coverOut);
  const result = await runValidator(args);
  return { result, sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
}

export interface LatestReleaseCheck {
  errors: string[];
  release?: GhRelease;
  check?: ZipCheck;
  /** 下载到本地的附件，调用方可以直接拿它做安全扫描，不用再下一遍 */
  zipPath?: string;
}

export async function checkLatestRelease(
  fullName: string,
  id: string,
  policy: MarketPolicy,
  workDir: string
): Promise<LatestReleaseCheck> {
  const assetName = `${id}.zip`;
  const releases = await listReleases(fullName);
  const release = releases.find((item) => item.assets.some((asset) => asset.name === assetName));
  if (!release) {
    return { errors: [`没有找到带 \`${assetName}\` 附件的 Release，请按模板推送 \`v<version>\` tag 发布。`] };
  }
  const asset = release.assets.find((item) => item.name === assetName)!;
  if (asset.size > policy.maxZipBytes) {
    return { errors: [`\`${assetName}\` 大小 ${asset.size} 超过上限 ${policy.maxZipBytes}。`], release };
  }
  const zipPath = join(workDir, `${id}-${release.tag_name}.zip`);
  const check = await downloadAndValidate(asset.browser_download_url, zipPath, {
    expectId: id,
    expectTag: release.tag_name,
    policy
  });
  const errors = check.result.errors.map((error) => `\`${error.code}\` ${error.detail}`);
  return { errors, release, check, zipPath };
}

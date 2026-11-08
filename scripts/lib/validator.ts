import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MarketPolicy } from "@/lib/types";
import { downloadBytes, type GhRelease, listReleases } from "./github";

export interface ValidatorResult {
  ok: boolean;
  errors: { code: string; detail: string }[];
  manifest: Record<string, unknown>;
  coverFile: string;
  hasAppSetting: boolean;
}

function runValidator(args: string[]): Promise<ValidatorResult> {
  const [command, ...prefix] = (process.env.PYTHON ?? "python").split(/\s+/).filter(Boolean);
  const script = join(resolve(process.env.TEMPLATE_DIR ?? ".plugin-template"), "scripts", "validate_plugin.py");
  return new Promise((done, fail) => {
    const child = spawn(command, [...prefix, script, ...args, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", fail);
    child.on("close", (code) => {
      const lastLine = stdout.trim().split("\n").pop() ?? "";
      if ((code === 0 || code === 1) && lastLine.startsWith("{")) {
        done(JSON.parse(lastLine) as ValidatorResult);
        return;
      }
      fail(new Error(`validator exited with ${code}: ${(stderr || stdout).trim()}`));
    });
  });
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
  const check = await downloadAndValidate(asset.browser_download_url, join(workDir, `${id}-${release.tag_name}.zip`), {
    expectId: id,
    expectTag: release.tag_name,
    policy
  });
  const errors = check.result.errors.map((error) => `\`${error.code}\` ${error.detail}`);
  return { errors, release, check };
}

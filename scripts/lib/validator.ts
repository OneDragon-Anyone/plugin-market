/** Python 工具通道与插件包校验：起子进程跑模板仓的 validate_plugin.py。 */

import { downloadBytes, type GhRelease, listReleases } from "./github";
import { type MarketPolicy } from "@/lib/types";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// ---- Python 子进程通道 ----

export interface PythonRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 本仓所有 Python 工具走同一条子进程通道，调用方自己决定退出码怎么处理 */
export function runPython(script: string, args: string[] = []): Promise<PythonRun> {
  const [command, ...prefix] = (process.env.PYTHON ?? "python").split(/\s+/).filter(Boolean);
  return new Promise((done, fail) => {
    const child = spawn(command, [...prefix, script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** Python 工具把结果写成 stdout 最后一行 JSON，前面的都是日志 */
export function lastJsonLine<T>(stdout: string, context: string): T {
  const line = stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) throw new Error(`${context} produced no JSON: ${line.slice(0, 200)}`);
  return JSON.parse(line) as T;
}

// ---- 插件包校验 ----

export interface ValidatorResult {
  ok: boolean;
  errors: { code: string; detail: string }[];
  manifest: Record<string, unknown>;
  coverFile: string;
  hasAppSetting: boolean;
}

async function runValidator(args: string[]): Promise<ValidatorResult> {
  const script = join(resolve(process.env.TEMPLATE_DIR ?? ".plugin-template"), "scripts", "validate_plugin.py");
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

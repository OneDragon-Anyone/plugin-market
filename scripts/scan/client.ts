/**
 * 扫描器的 TS 侧：起 Python 子进程跑 scan_plugin.py。
 * 只在收录时扫一次，结论进收录 issue 的评论；之后发的版本不再复查。结果不落缓存。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lastJsonLine, runPython } from "../lib/python";
const scannerPath = resolve(dirname(fileURLToPath(import.meta.url)), "scan_plugin.py");

export interface ScanFinding {
  code: string;
  severity: "block" | "review";
  /** 类别名由 Python 侧定义，TS 只做展示；新增类别不必同步改这里 */
  category: string;
  file: string;
  line: number;
  /** 写成「问题 + 怎么做」，原样进 issue 评论 */
  detail: string;
}

export interface ScanReport {
  scannedFiles: number;
  pythonFiles: number;
  findings: ScanFinding[];
  summary: { block: number; review: number };
}

export type ScanCheck = "static" | "dependency" | "malware";

export interface ScanOptions {
  /** 只跑这几类，不给就三类都跑 */
  checks?: ScanCheck[];
  /** 主程序环境里已经装好的 import 名，不当作第三方依赖 */
  hostPackages?: string[];
  /** 市场上已收录的插件 id，插件之间互相 import 不算第三方依赖 */
  knownPlugins?: string[];
}

/** 扫描器本身出问题时直接抛，调用方决定是拦下还是记一条提示 */
export async function scanZip(zipPath: string, options: ScanOptions = {}): Promise<ScanReport> {
  const args = ["--zip", zipPath];
  if (options.checks?.length) args.push("--checks", options.checks.join(","));
  if (options.hostPackages?.length) args.push("--host-packages", options.hostPackages.join(","));
  if (options.knownPlugins?.length) args.push("--known-plugins", options.knownPlugins.join(","));
  const run = await runPython(scannerPath, args);
  const line = run.stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) {
    throw new Error(`scanner produced no JSON: ${(run.stderr || run.stdout).trim().slice(0, 200)}`);
  }
  const report = lastJsonLine<ScanReport & { error?: string }>(run.stdout, "scanner");
  if (report.error) throw new Error(`scanner failed: ${report.error}`);
  return report;
}

/**
 * 一条命中项一行：位置 + 为什么算问题 + 该怎么改。
 * 同一个包、同一条规则在多处命中时合成一行，只把位置串起来——不合并的话
 * 一个包 import 三次就占三行，注释区读不下去。
 */
export function findingLines(report: ScanReport, severity: "block" | "review"): string[] {
  const groups = new Map<string, { sample: ScanFinding; places: string[] }>();
  for (const item of report.findings) {
    if (item.severity !== severity) continue;
    const place = `${item.file}${item.line ? `:${item.line}` : ""}`;
    const key = `${item.category}/${item.code} ${item.detail}`;
    const group = groups.get(key);
    if (group) group.places.push(place);
    else groups.set(key, { sample: item, places: [place] });
  }
  return [...groups.values()].map(({ sample, places }) => {
    const shown = places.slice(0, 5).join("、");
    const more = places.length > 5 ? ` 等 ${places.length} 处` : "";
    return `\`${sample.category}/${sample.code}\` ${shown}${more} — ${sample.detail}`;
  });
}

/** 说清这份结论覆盖了什么，免得人以为整包都被检查过 */
export function describeScan(report: ScanReport): string {
  return `扫过 ${report.scannedFiles} 个文件（Python ${report.pythonFiles}）`;
}

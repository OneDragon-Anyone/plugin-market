/**
 * 扫描器的 TS 侧：读规则版本、起 Python 子进程跑 scan_plugin.py、结果按 sha256 缓存。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lastJsonLine, runPython } from "../lib/validator";
const scannerPath = resolve(dirname(fileURLToPath(import.meta.url)), "scan_plugin.py");

/** 规则版本只由 Python 侧的 --version 给出；改规则时不必再同步改 TS，旧缓存自动失效 */
export async function readScanRuleVersion(): Promise<number> {
  const run = await runPython(scannerPath, ["--version"]);
  const { ruleVersion } = lastJsonLine<{ ruleVersion: number }>(run.stdout, "scanner --version");
  if (!Number.isInteger(ruleVersion) || ruleVersion < 1) {
    throw new Error(`scanner reported invalid rule version: ${String(ruleVersion)}`);
  }
  return ruleVersion;
}

export interface ScanFinding {
  code: string;
  severity: "block" | "review";
  /** 类别名由 Python 侧定义，TS 只做展示；新增类别不必同步改这里 */
  category: string;
  file: string;
  line: number;
  detail: string;
}

export interface ScanReport {
  ruleVersion: number;
  scannedFiles: number;
  pythonFiles: number;
  findings: ScanFinding[];
  summary: { block: number; review: number };
}

export interface ScanCacheEntry {
  id: string;
  tag: string;
  scannedAt: string;
  ruleVersion: number;
  status: "scanned" | "unavailable";
  report?: ScanReport;
}

interface ScanCacheFile {
  version: 1;
  results: Record<string, ScanCacheEntry>;
}

/**
 * 扫描器本身出问题时直接抛，调度层记一条「跳过」并且不写缓存，下轮重试。
 * 早先这里返回一份带 review 的假报告，会被当成正常结果缓存下来，那个包就再也不会重扫。
 */
export async function scanZip(zipPath: string): Promise<ScanReport> {
  const run = await runPython(scannerPath, ["--zip", zipPath]);
  const line = run.stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) {
    throw new Error(`scanner produced no JSON: ${(run.stderr || run.stdout).trim().slice(0, 200)}`);
  }
  const report = lastJsonLine<ScanReport & { error?: string }>(run.stdout, "scanner");
  if (report.error) throw new Error(`scanner failed: ${report.error}`);
  if (!Number.isInteger(report.ruleVersion)) throw new Error("scanner report has no ruleVersion");
  return report;
}

export function formatFindings(report: ScanReport, severity: "block" | "review", limit = 5): string {
  const hits = report.findings.filter((item) => item.severity === severity);
  const shown = hits
    .slice(0, limit)
    .map((item) => `${item.category}/${item.code} ${item.file}${item.line ? `:${item.line}` : ""}`);
  if (hits.length > limit) shown.push(`等 ${hits.length} 条`);
  return shown.join("; ");
}

/** 构建报告里说清这份扫描覆盖了什么 */
export function describeScan(report: ScanReport): string {
  return `扫过 ${report.scannedFiles} 个文件（Python ${report.pythonFiles}）`;
}

/**
 * 扫描结果按 zip 的 sha256 存 lock 分支。版本递增且发布后内容不可变，
 * 所以同一个指纹永远只需扫一次；规则版本变了才整体重扫。
 * ruleVersion 在构建启动时从 Python 读来，这里不再自带一份常量。
 */
export class ScanCache {
  private results: Record<string, ScanCacheEntry> = {};

  constructor(private readonly path: string, private readonly ruleVersion: number) {}

  get size(): number {
    return Object.keys(this.results).length;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf-8")) as ScanCacheFile;
      this.results = parsed.version === 1 && parsed.results ? parsed.results : {};
    } catch {
      this.results = {};
    }
  }

  get(sha256: string): ScanCacheEntry | null {
    const entry = this.results[sha256];
    return entry && entry.ruleVersion === this.ruleVersion ? entry : null;
  }

  async set(sha256: string, entry: ScanCacheEntry): Promise<void> {
    this.results[sha256] = entry;
    await mkdir(dirname(this.path), { recursive: true });
    const file: ScanCacheFile = { version: 1, results: this.results };
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  }
}

export function scanCachePath(lockDir: string): string {
  return join(lockDir, "scan-results.json");
}

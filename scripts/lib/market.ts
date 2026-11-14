/** 数据仓条目的读取、校验与格式化：字段规则、标签约束、写回格式。 */

import { checkMirror } from "./mirror";
import { pluginsDir, policyPath } from "./paths";
import { RISK_TAGS, type MarketPolicy, type MarketSourceEntry } from "@/lib/types";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---- 条目读取与校验 ----

export const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const MAX_TAGS = 8;
const STATUSES = new Set(["listed", "hidden", "deprecated", "suspended", "removed"]);
const ENTRY_KEYS = new Set(["id", "repo", "repoId", "tags", "extraRisk", "status", "pinned", "mirror", "review"]);
const REVIEW_KEYS = new Set(["issue", "pr", "submittedBy"]);

export async function readPolicy(): Promise<MarketPolicy> {
  return JSON.parse(await readFile(policyPath, "utf-8")) as MarketPolicy;
}

export async function readEntryFiles(): Promise<{ file: string; data: unknown }[]> {
  const files = (await readdir(pluginsDir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => ({ file, data: JSON.parse(await readFile(join(pluginsDir, file), "utf-8")) as unknown }))
  );
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function checkEntry(data: unknown, file: string, policy: MarketPolicy): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${file}: ${message}`);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    fail("must be a JSON object");
    return errors;
  }
  const entry = data as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) fail(`unknown field "${key}"`);

  if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) fail("id must match ^[a-z][a-z0-9_]*$");
  else {
    if (file !== `${entry.id}.json`) fail(`file name must be ${entry.id}.json`);
    if (policy.reservedIds.includes(entry.id)) fail(`id "${entry.id}" is reserved`);
  }
  if (typeof entry.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(entry.repo)) fail("repo must be owner/name");
  if (!isPositiveInt(entry.repoId)) fail("repoId must be a positive integer");
  else if (policy.bannedRepoIds.includes(entry.repoId)) fail("repoId is banned");
  if (
    !Array.isArray(entry.tags) ||
    entry.tags.length > MAX_TAGS ||
    entry.tags.some((tag) => typeof tag !== "string" || !TAG_PATTERN.test(tag))
  ) {
    fail(`tags must be at most ${MAX_TAGS} items matching ${TAG_PATTERN}`);
  }
  if (
    entry.extraRisk !== undefined &&
    (!Array.isArray(entry.extraRisk) || entry.extraRisk.some((risk) => !(RISK_TAGS as readonly unknown[]).includes(risk)))
  ) {
    fail("extraRisk contains unknown risk tags");
  }
  if (typeof entry.status !== "string" || !STATUSES.has(entry.status)) fail("invalid status");
  if (entry.pinned !== undefined && typeof entry.pinned !== "boolean") fail("pinned must be boolean");
  if (entry.mirror !== undefined) checkMirror(entry.mirror, fail);

  const review = entry.review as Record<string, unknown> | undefined;
  if (typeof review !== "object" || review === null) fail("review is required");
  else {
    for (const key of Object.keys(review)) if (!REVIEW_KEYS.has(key)) fail(`unknown field "review.${key}"`);
    if (typeof review.submittedBy !== "string" || !review.submittedBy) fail("review.submittedBy is required");
    if (review.issue !== undefined && !isPositiveInt(review.issue)) fail("review.issue must be an issue number");
    if (review.pr !== undefined && !isPositiveInt(review.pr)) fail("review.pr must be a PR number");
  }
  return errors;
}

export function checkEntries(
  files: { file: string; data: unknown }[],
  policy: MarketPolicy
): { entries: MarketSourceEntry[]; errors: string[] } {
  const errors = files.flatMap(({ file, data }) => checkEntry(data, file, policy));
  const entries = files.map(({ data }) => data as MarketSourceEntry);
  const seenRepoIds = new Map<number, string>();
  for (const entry of entries) {
    const other = seenRepoIds.get(entry.repoId);
    if (other) errors.push(`${entry.id}.json: repoId ${entry.repoId} already used by ${other}`);
    seenRepoIds.set(entry.repoId, entry.id);
  }
  return { entries, errors };
}

export function formatEntry(entry: MarketSourceEntry): string {
  const ordered = {
    id: entry.id,
    repo: entry.repo,
    repoId: entry.repoId,
    tags: entry.tags,
    extraRisk: entry.extraRisk ?? [],
    status: entry.status,
    pinned: entry.pinned ?? false,
    ...(entry.mirror !== undefined ? { mirror: entry.mirror } : {}),
    review: {
      ...(entry.review.issue ? { issue: entry.review.issue } : {}),
      ...(entry.review.pr ? { pr: entry.review.pr } : {}),
      submittedBy: entry.review.submittedBy
    }
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * 扫描调度：决定哪些版本要扫、存量版本每轮补扫几个、命中结果怎么落进构建报告，
 * 以及收尾时补发还没发出去的人工确认通知。
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MarketSourceEntry, PluginWarning } from "@/lib/types";
import { downloadBytes, type GhRepo } from "../lib/github";
import type { LockPlugin, BuildContext } from "../lib/lock";
import { describeScan, formatFindings, scanZip, type ScanReport } from "./client";
import { notifySecurityReview, securityNoticeKey } from "../issues/security";

/** 拿不到包且以后也拿不到的情况，记进缓存免得每轮重试 */
export class ScanUnavailable extends Error {}

/** 存量补扫每轮限量，剩下的下轮接着扫，免得首次上线一次性拉几十个包 */
const MAX_BACKFILL_SCANS_PER_RUN = 20;

/**
 * 按 sha256 复用扫描结果。版本递增且发布后内容不可变，命中缓存就不下载、不重扫；
 * 规则版本变更时缓存整体失效。
 */
export async function scanVersion(
  ctx: BuildContext,
  id: string,
  tag: string,
  sha256: string,
  getZip: () => Promise<string>
): Promise<ScanReport | null> {
  const cached = ctx.scanCache.get(sha256);
  if (cached) {
    if (cached.status === "unavailable") return null;
    if (cached.report) return cached.report;
  }
  try {
    const zipPath = await getZip();
    const result = await scanZip(zipPath);
    await ctx.scanCache.set(sha256, {
      id,
      tag,
      scannedAt: ctx.now.toISOString(),
      ruleVersion: result.ruleVersion,
      status: "scanned",
      report: result
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 扫描器自身故障（Python 起不来、输出坏掉等）也走这里，不写缓存，下轮自动重试。
    // 只有附件确实 404 才记 unavailable；限流、鉴权失败都是临时的，不能让这个包永不重扫。
    const permanent = error instanceof ScanUnavailable || /-> 404(?:\s|$)/.test(message);
    if (permanent) {
      await ctx.scanCache.set(sha256, {
        id,
        tag,
        scannedAt: ctx.now.toISOString(),
        ruleVersion: ctx.scanRuleVersion,
        status: "unavailable"
      });
    }
    ctx.report.push(`- ⚠️ \`${id}\` ${tag} 安全扫描跳过：${message.slice(0, 200)}`);
    return null;
  }
}

/**
 * 存量版本补扫：上线时把 lock 里已有版本过一遍，之后只剩新增版本会扫。
 * 存量命中阻断项只报告不动 lock，避免规则误判把线上插件批量下架。
 */
export async function scanExistingReleases(
  ctx: BuildContext,
  entry: MarketSourceEntry,
  repo: GhRepo,
  lock: LockPlugin,
  workDir: string,
  warnings: PluginWarning[]
): Promise<void> {
  for (const [tag, released] of Object.entries(lock.releases)) {
    if (released.revokedAt || ctx.scanCache.get(released.sha256)) continue;
    if (ctx.backfillScans >= MAX_BACKFILL_SCANS_PER_RUN) {
      ctx.report.push(`- ℹ️ 存量版本安全扫描本轮已达 ${MAX_BACKFILL_SCANS_PER_RUN} 个上限，剩余下轮继续`);
      return;
    }
    ctx.backfillScans++;
    const url = `https://github.com/${repo.full_name}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(released.assetName)}`;
    const result = await scanVersion(ctx, entry.id, tag, released.sha256, async () => {
      const data = await downloadBytes(url, ctx.policy.maxZipBytes);
      if (createHash("sha256").update(data).digest("hex") !== released.sha256) {
        throw new ScanUnavailable("附件内容与收录记录不一致");
      }
      const zipPath = join(workDir, `${entry.id}-${tag}-scan.zip`);
      await writeFile(zipPath, data);
      return zipPath;
    });
    if (!result) continue;
    if (result.summary.block > 0) {
      const detail = formatFindings(result, "block");
      warnings.push({
        code: "invalid_package",
        message: `${tag} 安全扫描命中阻断项：${detail}`,
        version: released.version
      });
      ctx.report.push(`- ⛔ \`${entry.id}\` ${tag} security_scan: ${detail}（${describeScan(result)}）`);
    }
  }
}

/**
 * 收尾补发人工确认通知。收录流程每个版本只跑一次，通知挂在里面一旦失败就再没机会，
 * 所以这里每轮按缓存报告把还没记指纹的版本重发一遍；发失败不记指纹，下轮自动重试。
 * 通知失败单独兜住，不会连累这个插件本轮收录。
 */
export async function notifyPendingSecurityReviews(
  ctx: BuildContext,
  entry: MarketSourceEntry,
  repo: GhRepo,
  lock: LockPlugin
): Promise<void> {
  for (const [tag, released] of Object.entries(lock.releases)) {
    if (released.revokedAt) continue;
    const report = ctx.scanCache.get(released.sha256)?.report;
    if (!report || report.summary.review === 0) continue;
    if ((lock.securityNotified ?? []).includes(securityNoticeKey(report, released.sha256))) continue;
    try {
      await notifySecurityReview({
        target: ctx.issueTarget,
        entry,
        repo,
        tag,
        sha256: released.sha256,
        report,
        lock,
        log: (line) => ctx.report.push(line)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.report.push(`- ⚠️ \`${entry.id}\` ${tag} 安全扫描通知发送失败，下轮重试：${message.slice(0, 160)}`);
    }
  }
}

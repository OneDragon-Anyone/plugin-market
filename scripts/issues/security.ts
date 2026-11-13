/**
 * 安全扫描待确认通知：新扫出的 review 项提醒维护者人工确认。
 * 一条 issue 对应一个插件，后续新命中以评论追加。是否关闭交给维护者判断 ——
 * 某个版本这次扫干净了，不代表这个插件其他版本也干净，自动关会误导人。
 */

import type { MarketSourceEntry } from "@/lib/types";
import { orNull, openIssue, tryCommentIssue, type GhRepo } from "../lib/github";
import type { LockPlugin } from "../lib/lock";
import { describeScan, formatFindings, type ScanFinding, type ScanReport } from "../scan/client";
import { issueRef, paragraph, pluginRef } from "./body";

export interface SecurityNoticeOptions {
  /** 自动 issue 要写进去的仓库 空串表示这轮不发 */
  target: string;
  entry: MarketSourceEntry;
  repo: GhRepo;
  tag: string;
  sha256: string;
  report: ScanReport;
  lock: LockPlugin;
  log: (line: string) => void;
}

/** 规则版本变了会重扫并可能命中新项，指纹得带上版本，不然会被旧记录挡掉 */
export function securityNoticeKey(report: ScanReport, sha256: string): string {
  return `${report.ruleVersion}:${sha256}`;
}

function hitLines(findings: ScanFinding[]): string[] {
  return findings.map(
    (item) => `- \`${item.category}/${item.code}\` ${item.file}${item.line ? `:${item.line}` : ""} — ${item.detail}`
  );
}

function bodyOf(options: SecurityNoticeOptions, hits: ScanFinding[]): string {
  return [
    `插件 ${pluginRef(options.entry, options.repo)} 的 \`${options.tag}\` 安装包（sha256 \`${options.sha256.slice(0, 12)}\`）命中了需要人工确认的扫描项。`,
    "",
    "构建不会据此拦截或下架，请维护者确认后决定是否跟进作者。",
    ...paragraph("命中项："),
    ...hitLines(hits),
    ...paragraph(`扫描覆盖：${describeScan(options.report)}，规则版本 ${options.report.ruleVersion}。`),
    ...paragraph("同一个包只通知一次，后续新命中会以评论追加到这条 issue。")
  ].join("\n");
}

/** 只处理 review；block 由收录流程直接拦下，不在这里发 issue */
export async function notifySecurityReview(options: SecurityNoticeOptions): Promise<void> {
  const { entry, report, tag, sha256, lock, log } = options;
  const hits = report.findings.filter((item) => item.severity === "review");
  if (hits.length === 0) return;

  // 本地跑或没开自动 issue 时，至少在构建摘要里留一行
  if (options.target === "") {
    log(`- ⚠️ \`${entry.id}\` ${tag} security_scan 待人工确认：${formatFindings(report, "review")}（${describeScan(report)}）`);
    return;
  }

  const key = securityNoticeKey(report, sha256);
  const notified = lock.securityNotified ?? [];
  if (notified.includes(key)) return;

  let issue = lock.securityIssue ?? 0;
  let appended = false;
  if (issue > 0) {
    appended = await tryCommentIssue(
      options.target,
      issue,
      [`新增待确认项：\`${tag}\`（sha256 \`${sha256.slice(0, 12)}\`）`, "", ...hitLines(hits)].join("\n")
    );
  }
  if (!appended) {
    // 没有 issue 或原来那条被删了，重新开一条；开失败不记指纹，下轮会重试
    const opened = await orNull(
      openIssue(options.target, {
        title: `[security] ${entry.id} 的安装包有待人工确认的扫描项`,
        labels: ["security", "needs-review"],
        body: bodyOf(options, hits)
      })
    );
    if (opened === null) {
      log(`- ⚠️ \`${entry.id}\` 安全扫描通知发送失败，本轮跳过`);
      return;
    }
    issue = opened;
    lock.securityIssue = opened;
    log(`- 📮 ${entry.id} 已开 issue ${issueRef(options.target, opened)} 等待人工确认`);
  } else {
    log(`- 📮 ${entry.id} 新增待确认项已补进 issue ${issueRef(options.target, issue)}`);
  }
  lock.securityNotified = [...notified, key];
}

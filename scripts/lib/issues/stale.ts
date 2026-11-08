import type { MarketSourceEntry } from "@/lib/types";
import { openIssue } from "./api";

/**
 * 仓库连续多天不可访问 提醒维护者决定要不要标成 suspended。
 * target 是自动 issue 要写进去的仓库，空串表示这轮不发。
 */
export async function openStaleIssue(entry: MarketSourceEntry, days: number, target: string): Promise<number | undefined> {
  if (target === "") return undefined;
  return openIssue(target, {
    title: `[stale] ${entry.id} 的仓库已连续 ${days} 天无法访问`,
    labels: ["stale"],
    body: [
      `插件 \`${entry.id}\`（repoId ${entry.repoId}，提交时为 \`${entry.repo}\`）的仓库已连续 ${days} 天无法访问，网站已标记为 stale。`,
      "",
      "请维护者确认后决定是否将 `status` 改为 `suspended`。"
    ].join("\n")
  });
}

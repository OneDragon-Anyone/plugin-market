import { github, orNull } from "../github";
import { ensureLabels } from "./labels";

export interface IssueDraft {
  title: string;
  body: string;
  /** 顺带打上的标签 不存在会先建出来 */
  labels?: string[];
}

/** 开一条新 issue 返回编号 */
export async function openIssue(repo: string, draft: IssueDraft): Promise<number> {
  if (draft.labels?.length) await ensureLabels(repo, draft.labels);
  const issue = await github<{ number: number }>(`/repos/${repo}/issues`, { method: "POST", body: draft });
  return issue.number;
}

/** 往已有 issue 补一条评论 失败就抛出 */
export async function commentIssue(repo: string, issue: number, body: string): Promise<void> {
  await github(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: { body } });
}

/**
 * 往一条可能已经不存在的 issue 补评论。
 * 返回 false 只代表这条 issue 被删了 —— 关掉的照样能评论，关闭不等于问题解决。
 */
export async function tryCommentIssue(repo: string, issue: number, body: string): Promise<boolean> {
  return (await orNull(commentIssue(repo, issue, body))) !== null;
}

/** 关闭 issue 带 reason 时 GitHub 会记下关闭原因 */
export async function closeIssue(repo: string, issue: number, reason?: "completed" | "not_planned"): Promise<void> {
  await github(`/repos/${repo}/issues/${issue}`, {
    method: "PATCH",
    body: reason ? { state: "closed", state_reason: reason } : { state: "closed" }
  });
}

import { GitHubError, github } from "../github";

/**
 * 仓库用到的标签，一处定义。
 * 提交机器人靠它建标签、打标签，构建流程开自动 issue 时也用它，
 * 免得同一个标签两边各写一份，改了一处忘了另一处。
 */
export const LABELS: Record<string, { color: string; description: string }> = {
  submission: { color: "1d76db", description: "插件收录申请" },
  pending: { color: "fbca04", description: "校验通过，等待维护者审核 PR" },
  approved: { color: "0e8a16", description: "已收录" },
  rejected: { color: "d93f0b", description: "校验未通过或审核拒绝" },
  "needs-review": { color: "c5def5", description: "需要维护者人工确认后才会处理" },
  spam: { color: "000000", description: "格式不符的 Issue" },
  transfer: { color: "5319e7", description: "插件转移申请" },
  report: { color: "b60205", description: "插件举报" },
  appeal: { color: "bfd4f2", description: "申诉" },
  stale: { color: "cccccc", description: "插件仓库长期无法访问" },
  revoked: { color: "e99695", description: "已收录版本的安装包与市场记录不一致" }
};

/** 已存在的标签 GitHub 返回 422，当成功处理 */
async function ensureLabel(repo: string, name: string): Promise<void> {
  try {
    await github(`/repos/${repo}/labels`, { method: "POST", body: { name, ...LABELS[name] } });
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
  }
}

/** 开 issue 前先把要用的标签备好，不然带上不存在的标签会被拒 */
export async function ensureLabels(repo: string, names: string[]): Promise<void> {
  for (const name of names) await ensureLabel(repo, name);
}

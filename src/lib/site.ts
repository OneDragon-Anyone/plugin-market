export const siteConfig = {
  name: "ZZZ OneDragon Plugin Market",
  shortName: "ZZZOD Plugins",
  repoOwner: import.meta.env.PUBLIC_GITHUB_OWNER ?? "OneDragon-Anyone",
  repoName: import.meta.env.PUBLIC_GITHUB_REPO ?? "plugin-data",
  templateRepo: "OneDragon-Anyone/plugin-template",
  basePath: import.meta.env.PUBLIC_BASE_PATH ?? "/plugin-data"
};

export type IssueTemplate = "1-submission.yml" | "2-transfer.yml" | "3-report.yml" | "4-appeal.yml";

/** GitHub Issue 表单支持用字段 id 作为查询参数预填。 */
export function issueFormUrl(template: IssueTemplate, fields: Record<string, string> = {}): string {
  const params = new URLSearchParams({ template });
  for (const [key, value] of Object.entries(fields)) {
    if (value) params.set(key, value);
  }
  return `https://github.com/${siteConfig.repoOwner}/${siteConfig.repoName}/issues/new?${params.toString()}`;
}

/** 预填标题和正文的空白 Issue 链接；Issue 表单的字段无法通过 URL 预填，因此提交按钮走这条路径。 */
export function issueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ title, body });
  return `https://github.com/${siteConfig.repoOwner}/${siteConfig.repoName}/issues/new?${params.toString()}`;
}

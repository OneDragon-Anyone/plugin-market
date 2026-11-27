/**
 * 站点配置与 Issue 链接构造。
 *
 * 品牌名来自数据仓 policy.json 的 site 段，构建期由 astro.config 注入；
 * 数据仓坐标只用于拼 Issue 链接，由部署环境变量给出。
 */

import { resolveSite, type SiteConfig } from "./config";

interface InjectedConfig {
  site?: Partial<SiteConfig>;
}

const env = import.meta.env as Record<string, string | undefined>;

function readInjected(): InjectedConfig {
  const raw = env.PUBLIC_MARKET_CONFIG;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as InjectedConfig;
  } catch {
    // 注入内容坏了按没配处理，站点仍然能构建
    return {};
  }
}

const injected = readInjected();
const brand = resolveSite(injected.site);

export const siteConfig = {
  ...brand,
  /**
   * 浏览器存储键前缀，由简称派生。同域名下挂多个市场时简称不同就互不覆盖，
   * 不用另配一项；改简称会让已存的主题与导航状态失效一次。
   */
  storagePrefix: brand.short.toLowerCase(),
  repoOwner: env.PUBLIC_GITHUB_OWNER ?? "OneDragon-Anyone",
  repoName: env.PUBLIC_GITHUB_REPO ?? "plugin-data"
};

/** 标题后缀：简称 + 补充词，补充词留空时只留简称 */
export function brandSuffix(): string {
  return `${siteConfig.short} ${siteConfig.subtitle}`.trim();
}

/** 页面标题 = 页面名 + 品牌后缀 */
export function pageTitle(page: string): string {
  return `${page} · ${brandSuffix()}`;
}

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

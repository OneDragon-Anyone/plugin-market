/**
 * 市场实例配置：站点品牌与客户端依赖清单的来源。
 *
 * 每个市场各一份，由数据仓 policy.json 的 site / client 段声明；没配的项走下面的默认值，
 * 引擎自身也能构建出一个空市场。
 */

export interface SiteConfig {
  /** 站点全名，只用在页脚 */
  name: string;
  /** 侧栏标志里的文字，一到两个字符最合适 */
  logo: string;
  /** 简称，用于页面标题后缀 */
  short: string;
  /** 简称后面的补充词，留空则不显示 */
  subtitle: string;
  /** 首页描述，也是全站默认描述 */
  description: string;
}

export interface ClientConfig {
  /** 客户端依赖锁文件的地址，如仓库里 uv.lock 的 raw 链接 */
  lockUrl: string;
  /** 客户端自带的模块根，插件 import 它们不算绕开客户端的依赖体系 */
  moduleRoots: string[];
}

/** 没配的项走这里：一个不带任何具体项目痕迹的空市场 */
const DEFAULT_SITE: SiteConfig = {
  name: "插件市场",
  logo: "PM",
  short: "Plugins",
  subtitle: "",
  description: "浏览、安装与提交插件。"
};

/** 空字符串视为没配，免得数据仓只写一半把默认值冲掉 */
export function resolveSite(raw?: Partial<SiteConfig> | null): SiteConfig {
  return {
    name: raw?.name || DEFAULT_SITE.name,
    logo: raw?.logo || DEFAULT_SITE.logo,
    short: raw?.short || DEFAULT_SITE.short,
    subtitle: raw?.subtitle || DEFAULT_SITE.subtitle,
    description: raw?.description || DEFAULT_SITE.description
  };
}

/**
 * 没有锁文件地址就没有可抓的依赖清单，按未配置处理，调用方据此跳过依赖扫描，
 * 而不是拿空白名单去误报第三方包。模块根只在有清单时才有意义，一并留空。
 */
export function resolveClient(raw?: Partial<ClientConfig> | null): ClientConfig | null {
  const lockUrl = typeof raw?.lockUrl === "string" ? raw.lockUrl.trim() : "";
  if (!lockUrl) return null;
  const moduleRoots = Array.isArray(raw?.moduleRoots)
    ? raw.moduleRoots.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  return { lockUrl, moduleRoots: [...new Set(moduleRoots)].sort() };
}

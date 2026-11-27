import type { ThemeMode } from "./win11";
import { siteConfig } from "@/lib/site";

export type { ThemeMode } from "./win11";

/** 存储前缀来自数据仓的站点配置，同一浏览器访问多个市场时互不覆盖 */
export const THEME_STORAGE_KEY = `${siteConfig.storagePrefix}-theme`;

export function resolveThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "dark";

  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;

  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}

export function persistThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 隐私模式下 localStorage 不可写，主题仍应在当前页面生效
  }
}

import type { PluginEntry, PluginRelease, MarketStatus, RiskTag } from "./types";
import { withBase } from "./utils";

export const statusLabels: Record<MarketStatus, string> = {
  listed: "已上架",
  deprecated: "已弃用",
  hidden: "已隐藏",
  suspended: "已暂停",
  removed: "已移除"
};

export function statusColor(value: MarketStatus): string {
  if (value === "listed") return "green";
  if (value === "deprecated") return "orange";
  if (value === "hidden") return "gray";
  return "red";
}

export function riskColor(value: RiskTag): string {
  if (value === "automation") return "orange";
  if (value === "account" || value === "process") return "red";
  if (value === "network" || value === "ocr" || value === "yolo") return "blue";
  return "gray";
}

export function primaryRelease(plugin: PluginEntry): PluginRelease | null {
  return plugin.latest ?? plugin.latestBeta;
}

export function coverUrl(plugin: PluginEntry): string {
  return plugin.cover ? withBase(`/api/v1/${plugin.cover}`) : "";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function formatCount(value: number): string {
  return value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

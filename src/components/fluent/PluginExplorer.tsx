import React, { useMemo, useState } from "react";
import Fuse from "fuse.js";
import {
  Badge,
  Button,
  Dropdown,
  Option,
  SearchBox,
  Tag
} from "@fluentui/react-components";
import {
  Search20Regular,
  Star16Filled,
  ArrowDownload16Regular,
  Open16Regular,
  PuzzlePiece24Regular,
  Add16Regular
} from "@fluentui/react-icons";
import type { MarketPlugin } from "@/lib/types";
import { formatCount, primaryRelease } from "@/lib/display";
import { riskLabels } from "@/lib/risk";
import { withBase } from "@/lib/utils";

interface PluginExplorerProps {
  plugins: MarketPlugin[];
}

const sortOptions = [
  { value: "recommended", label: "推荐排序" },
  { value: "updated", label: "最近更新" },
  { value: "stars", label: "最多 Stars" },
  { value: "downloads", label: "最多下载" },
  { value: "name", label: "名称排序" }
];

export const PluginExplorer: React.FC<PluginExplorerProps> = ({ plugins }) => {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("all");
  const [showDeprecated, setShowDeprecated] = useState(false);
  const [sort, setSort] = useState("recommended");

  const visiblePlugins = useMemo(
    () => plugins.filter((p) => p.status === "listed" || p.status === "deprecated"),
    [plugins]
  );

  const fuse = useMemo(
    () =>
      new Fuse(visiblePlugins, {
        threshold: 0.32,
        keys: ["id", "name", "summary", "author.name", "tags"]
      }),
    [visiblePlugins]
  );

  const tags = useMemo(
    () => Array.from(new Set(visiblePlugins.flatMap((p) => p.tags))).sort(),
    [visiblePlugins]
  );

  const deprecatedCount = useMemo(
    () => visiblePlugins.filter((p) => p.status === "deprecated").length,
    [visiblePlugins]
  );

  const filteredPlugins = useMemo(() => {
    const searched = query.trim()
      ? fuse.search(query.trim()).map((res) => res.item)
      : [...visiblePlugins];

    const filtered = searched.filter(
      (p) =>
        (activeTag === "all" || p.tags.includes(activeTag)) &&
        (showDeprecated || p.status !== "deprecated")
    );

    if (sort === "recommended" && query.trim()) return filtered;

    return filtered.sort((a, b) => {
      if (sort === "stars") return b.stars - a.stars;
      if (sort === "downloads") return b.downloads - a.downloads;
      if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
      if (sort === "updated") return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.status !== b.status) return a.status === "listed" ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [query, activeTag, showDeprecated, sort, fuse, visiblePlugins]);

  const sortLabel = sortOptions.find((option) => option.value === sort)?.label;

  return (
    <div className="page">
      <header className="page-header">
        <div className="flex items-center gap-2.5">
          <h1 className="page-title">插件市场</h1>
          <Badge appearance="tint" color="brand" size="medium">
            {visiblePlugins.length}
          </Badge>
        </div>
        <Button
          as="a"
          href={withBase("/submission/")}
          appearance="primary"
          icon={<Add16Regular />}
        >
          提交插件
        </Button>
      </header>

      <div className="market-toolbar">
        <SearchBox
          className="market-search"
          value={query}
          onChange={(_, data) => setQuery(data.value)}
          placeholder="搜索插件或作者..."
          contentBefore={<Search20Regular />}
          aria-label="搜索插件"
        />
        <Dropdown
          className="market-sort"
          value={sortLabel}
          selectedOptions={[sort]}
          onOptionSelect={(_, data) => setSort(data.optionValue ?? "recommended")}
          aria-label="排序方式"
        >
          {sortOptions.map((option) => (
            <Option key={option.value} value={option.value}>
              {option.label}
            </Option>
          ))}
        </Dropdown>
        <span className="text-caption market-count">共 {filteredPlugins.length} 款插件</span>
      </div>

      <div className="filter-chips" role="group" aria-label="按标签筛选">
        <button
          type="button"
          className="chip"
          aria-pressed={activeTag === "all"}
          onClick={() => setActiveTag("all")}
        >
          全部标签
        </button>
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="chip"
            aria-pressed={activeTag === tag}
            onClick={() => setActiveTag(tag)}
          >
            #{tag}
          </button>
        ))}
        {deprecatedCount > 0 && (
          <button
            type="button"
            className="chip chip--warning"
            aria-pressed={showDeprecated}
            onClick={() => setShowDeprecated((value) => !value)}
          >
            显示已弃用 ({deprecatedCount})
          </button>
        )}
      </div>

      {filteredPlugins.length === 0 ? (
        <div className="surface surface--flat empty-state">
          <PuzzlePiece24Regular />
          <span className="text-body">未找到匹配的插件</span>
        </div>
      ) : (
        <div className="plugin-grid">
          {filteredPlugins.map((plugin) => {
            const release = primaryRelease(plugin);
            return (
              <article
                key={plugin.id}
                className="surface plugin-card"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a, button")) return;
                  window.location.href = withBase(`/plugins/${plugin.id}/`);
                }}
                role="link"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    window.location.href = withBase(`/plugins/${plugin.id}/`);
                  }
                }}
              >
                <div className="plugin-card-head">
                  <span className="icon-tile" aria-hidden="true">
                    <PuzzlePiece24Regular />
                  </span>
                  <div className="plugin-card-heading">
                    <a
                      className="plugin-title"
                      href={withBase(`/plugins/${plugin.id}/`)}
                    >
                      {plugin.name}
                    </a>
                    <span className="plugin-meta">
                      {plugin.id} · @{plugin.author.name}
                    </span>
                  </div>
                  <div className="plugin-badges">
                    {plugin.pinned && (
                      <Badge appearance="tint" color="brand" size="small">
                        精选
                      </Badge>
                    )}
                    {plugin.status === "deprecated" && (
                      <Badge appearance="tint" color="warning" size="small">
                        已弃用
                      </Badge>
                    )}
                    <Badge appearance="outline" size="small">
                      v{release?.version ?? "0.0.0"}
                    </Badge>
                  </div>
                </div>

                <p className="plugin-summary">{plugin.summary}</p>

                <div className="plugin-tags">
                  {plugin.tags.slice(0, 3).map((tag) => (
                    <Tag key={tag} size="small" appearance="outline">
                      #{tag}
                    </Tag>
                  ))}
                  {plugin.risk.slice(0, 2).map((risk) => (
                    <span key={risk} className="risk-chip">
                      {riskLabels[risk]}
                    </span>
                  ))}
                </div>

                <div className="plugin-card-footer">
                  <div className="plugin-stats">
                    <span title="Stars">
                      <Star16Filled className="star-icon" />
                      {formatCount(plugin.stars)}
                    </span>
                    <span title="下载量">
                      <ArrowDownload16Regular />
                      {formatCount(plugin.downloads)}
                    </span>
                  </div>
                  <div className="plugin-actions">
                    <Button
                      as="a"
                      href={plugin.repo}
                      target="_blank"
                      rel="noreferrer"
                      appearance="subtle"
                      size="small"
                      icon={<Open16Regular />}
                      onClick={(e) => e.stopPropagation()}
                    >
                      源码
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PluginExplorer;

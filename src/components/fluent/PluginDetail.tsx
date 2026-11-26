import React from "react";
import {
  Badge,
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbDivider,
  BreadcrumbItem,
  Button,
  Divider,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Tab,
  TabList,
  Tag
} from "@fluentui/react-components";
import {
  ArrowDownload16Regular,
  ArrowDownload20Regular,
  Open16Regular,
  PuzzlePiece24Regular
} from "@fluentui/react-icons";
import type { MarketPlugin } from "@/lib/types";
import {
  formatBytes,
  formatCount,
  formatDate,
  primaryRelease,
  statusLabels
} from "@/lib/display";
import { riskDescriptions, riskLabels } from "@/lib/risk";
import { issueFormUrl } from "@/lib/site";
import { withBase } from "@/lib/utils";

interface PluginDetailProps {
  plugin: MarketPlugin;
}

export const PluginDetail: React.FC<PluginDetailProps> = ({ plugin }) => {
  const [selectedTab, setSelectedTab] = React.useState<"readme" | "releases">("readme");
  const release = primaryRelease(plugin);
  const downloadable = plugin.status !== "suspended" && release?.downloadUrl;

  const reportUrl = issueFormUrl("3-report.yml", {
    title: `[report] ${plugin.id}`,
    plugin_id: plugin.id
  });
  const appealUrl = issueFormUrl("4-appeal.yml", {
    title: `[appeal] ${plugin.id}`,
    target: plugin.id
  });

  return (
    <div className="page">
      <Breadcrumb aria-label="面包屑">
        <BreadcrumbItem>
          <BreadcrumbButton as="a" href={withBase("/")}>
            插件市场
          </BreadcrumbButton>
        </BreadcrumbItem>
        <BreadcrumbDivider />
        <BreadcrumbItem>
          <BreadcrumbButton current>{plugin.name}</BreadcrumbButton>
        </BreadcrumbItem>
      </Breadcrumb>

      <div className="detail-grid">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="surface detail-header">
            <span className="icon-tile icon-tile--lg" aria-hidden="true">
              <PuzzlePiece24Regular />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="detail-title">{plugin.name}</h1>
                <Badge appearance="tint" color="brand">
                  v{release?.version ?? "0.0.0"}
                </Badge>
                {plugin.pinned && (
                  <Badge appearance="tint" color="brand">
                    精选
                  </Badge>
                )}
                {plugin.status !== "listed" && (
                  <Badge
                    appearance="tint"
                    color={plugin.status === "deprecated" ? "warning" : "danger"}
                  >
                    {statusLabels[plugin.status]}
                  </Badge>
                )}
              </div>
              <span className="text-caption mono mt-1 block">
                {plugin.id} · 由 @{plugin.author.name} 开发
              </span>
              <p className="detail-summary">{plugin.summary}</p>

              <div className="plugin-tags mt-3">
                {plugin.tags.map((tag) => (
                  <Tag key={tag} size="small" appearance="outline">
                    #{tag}
                  </Tag>
                ))}
                {plugin.risk.map((risk) => (
                  <span key={risk} className="risk-chip">
                    {riskLabels[risk]}
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3 mt-4">
                {downloadable && release ? (
                  <Button
                    as="a"
                    href={release.downloadUrl}
                    appearance="primary"
                    size="large"
                    icon={<ArrowDownload20Regular />}
                  >
                    下载 {release.assetName}
                  </Button>
                ) : (
                  <Button disabled appearance="secondary" size="large">
                    暂未分发
                  </Button>
                )}
                <Button
                  as="a"
                  href={plugin.repo}
                  target="_blank"
                  rel="noreferrer"
                  appearance="secondary"
                  size="large"
                  icon={<Open16Regular />}
                >
                  GitHub 源码
                </Button>
              </div>
            </div>
          </section>

          {plugin.status === "suspended" && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>已暂停分发</MessageBarTitle>
                该插件因安全或合规问题已被暂停，不再提供下载。作者可通过申诉 Issue 申请恢复。
              </MessageBarBody>
            </MessageBar>
          )}

          {plugin.status === "deprecated" && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>已弃用</MessageBarTitle>
                作者或平台已停止推荐此插件，可能不再接收更新维护。
              </MessageBarBody>
            </MessageBar>
          )}

          {plugin.stale && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>仓库失联</MessageBarTitle>
                源仓库已连续多日无法访问，当前展示的数据来自最后一次成功抓取。
              </MessageBarBody>
            </MessageBar>
          )}

          <section className="min-w-0">
            <TabList
              className="detail-tabs"
              selectedValue={selectedTab}
              onTabSelect={(_, data) => setSelectedTab(data.value as "readme" | "releases")}
              appearance="subtle"
            >
              <Tab value="readme">说明文档</Tab>
              <Tab value="releases">版本历史 ({plugin.releases.length})</Tab>
            </TabList>

            <div className="mt-4">
              {selectedTab === "readme" ? (
                <div className="surface detail-panel">
                  {plugin.readmeHtml ? (
                    <div
                      className="prose max-w-none"
                      dangerouslySetInnerHTML={{ __html: plugin.readmeHtml }}
                    />
                  ) : (
                    <div className="empty-state">
                      <span className="text-body">该插件仓库未提供 README 文档。</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="surface release-list">
                  {plugin.releases.map((rel) => (
                    <article key={rel.tag} className="release-item">
                      <div className="release-head">
                        <div className="release-title">
                          <span>v{rel.version}</span>
                          {rel === plugin.latest && (
                            <Badge appearance="tint" color="success" size="small">
                              最新版
                            </Badge>
                          )}
                          {rel.prerelease && (
                            <Badge appearance="tint" color="informative" size="small">
                              测试版
                            </Badge>
                          )}
                          <span className="text-caption mono">{formatDate(rel.publishedAt)}</span>
                        </div>
                        {downloadable && (
                          <Button
                            as="a"
                            href={rel.downloadUrl}
                            size="small"
                            appearance="subtle"
                            icon={<ArrowDownload16Regular />}
                          >
                            {formatBytes(rel.size)}
                          </Button>
                        )}
                      </div>

                      {rel.changelogHtml && (
                        <div
                          className="prose mt-2"
                          dangerouslySetInnerHTML={{ __html: rel.changelogHtml }}
                        />
                      )}

                      <div className="release-foot">
                        <span>versionCode: {rel.versionCode}</span>
                        <span>commit: {rel.commit.slice(0, 7)}</span>
                        <span>sha256: {rel.sha256.slice(0, 12)}…</span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="detail-rail">
          <section className="surface surface--padded flex flex-col gap-4">
            <h2 className="section-title">技术规格</h2>

            <div className="meta-list">
              <div className="meta-row">
                <span className="meta-label">开源仓库</span>
                <a
                  href={plugin.repo}
                  target="_blank"
                  rel="noreferrer"
                  className="meta-value inline-flex items-center gap-1"
                >
                  GitHub <Open16Regular />
                </a>
              </div>
              <div className="meta-row">
                <span className="meta-label">作者</span>
                <span className="meta-value">@{plugin.author.name}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Star 数量</span>
                <span className="meta-value">{formatCount(plugin.stars)}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">总下载量</span>
                <span className="meta-value">{formatCount(plugin.downloads)}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">文件大小</span>
                <span className="meta-value">{release ? formatBytes(release.size) : "-"}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">更新时间</span>
                <span className="meta-value">{formatDate(plugin.updatedAt)}</span>
              </div>
            </div>

            {release?.sha256 && (
              <div>
                <div className="text-caption mb-1">SHA-256 校验指纹</div>
                <div className="code-block">{release.sha256}</div>
              </div>
            )}

            {plugin.risk.length > 0 && (
              <>
                <Divider />
                <div className="flex flex-col gap-2">
                  <h2 className="section-title">安全与权限申报</h2>
                  {plugin.risk.map((risk) => (
                    <div key={risk} className="risk-item">
                      <div className="risk-item-title">{riskLabels[risk]}</div>
                      <div className="text-caption">{riskDescriptions[risk]}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <Divider />

            <div className="text-caption flex items-center justify-between gap-3">
              <a
                href={reportUrl}
                target="_blank"
                rel="noreferrer"
                className="text-secondary hover:underline"
              >
                举报该插件
              </a>
              {plugin.status === "suspended" && (
                <a
                  href={appealUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-secondary hover:underline"
                >
                  作者申诉
                </a>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
};

export default PluginDetail;

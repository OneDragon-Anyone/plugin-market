import React from "react";
import { Button } from "@fluentui/react-components";
import { Open16Regular } from "@fluentui/react-icons";
import FluentShell from "@/components/fluent/FluentShell";
import { withBase } from "@/lib/utils";

const endpoints = [
  {
    href: "/api/v1/index.json",
    method: "GET",
    title: "/api/v1/index.json",
    desc: "获取注册表基础元数据、版本与收录数量统计。"
  },
  {
    href: "/api/v1/plugins.json",
    method: "GET",
    title: "/api/v1/plugins.json",
    desc: "获取所有已上架插件的全量配置与最新发布版本信息。"
  },
  {
    href: "/api/v1/stats.json",
    method: "GET",
    title: "/api/v1/stats.json",
    desc: "各插件的 Stars 与下载量，与插件索引分开维护。下载量为 GitHub 与国内镜像源的合计。"
  },
  {
    href: "/api/v1/search-index.json",
    method: "GET",
    title: "/api/v1/search-index.json",
    desc: "轻量级 Fuse 本地搜索索引，适合客户端离线模糊匹配。"
  },
  {
    href: "/api/v1/plugins/music_game_26.json",
    method: "GET",
    title: "/api/v1/plugins/{id}.json",
    desc: "单个插件的完整配置详情、版本历史与完整说明文档。"
  }
];

export const ApiDocsApp: React.FC = () => (
  <FluentShell activeTab="api" pageTitle="API 文档">
    <div className="page page--medium">
      <header className="page-header">
        <h1 className="page-title">API 文档</h1>
      </header>

      <section className="surface endpoint-list">
        {endpoints.map((endpoint) => (
          <article key={endpoint.href} className="endpoint-row">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="method-pill">{endpoint.method}</span>
                <span className="mono text-sm font-semibold">{endpoint.title}</span>
              </div>
              <span className="text-caption">{endpoint.desc}</span>
            </div>
            <Button
              as="a"
              href={withBase(endpoint.href)}
              target="_blank"
              rel="noreferrer"
              appearance="subtle"
              size="small"
              icon={<Open16Regular />}
            >
              查看数据
            </Button>
          </article>
        ))}
      </section>
    </div>
  </FluentShell>
);

export default ApiDocsApp;

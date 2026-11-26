import React from "react";
import FluentShell from "@/components/fluent/FluentShell";
import { RISK_TAGS } from "@/lib/types";
import { riskDescriptions, riskLabels } from "@/lib/risk";

const statuses = [
  { tag: "listed", name: "已上架", desc: "审核通过，在商店正常展示，允许安装与更新" },
  { tag: "deprecated", name: "已弃用", desc: "作者或平台停止推荐，展示弃用警告，允许继续使用" },
  { tag: "hidden", name: "已隐藏", desc: "不出现在商店列表中，仅支持通过直链安装访问" },
  { tag: "suspended", name: "已暂停", desc: "存在安全风险或严重违规，已暂停分发与更新" },
  { tag: "removed", name: "已移除", desc: "完全从索引中删除" }
];

export const PolicyApp: React.FC = () => (
  <FluentShell activeTab="policy" pageTitle="规范说明">
    <div className="page page--medium">
      <header className="page-header">
        <h1 className="page-title">规范说明</h1>
      </header>

      <section className="surface surface--padded">
        <h2 className="section-title mb-3">权限与安全风险标签</h2>
        <div className="policy-grid">
          {RISK_TAGS.map((tag) => (
            <div key={tag} className="policy-item">
              <div className="policy-item-head">
                <span className="tag-code">{tag}</span>
                <span className="text-caption font-medium">{riskLabels[tag]}</span>
              </div>
              <div className="text-caption">{riskDescriptions[tag]}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="surface surface--padded">
        <h2 className="section-title mb-3">插件分发状态定义</h2>
        <div className="policy-grid">
          {statuses.map((status) => (
            <div key={status.tag} className="policy-item">
              <div className="policy-item-head">
                <span className="tag-code mono">{status.tag}</span>
                <span className="text-caption font-medium">{status.name}</span>
              </div>
              <div className="text-caption">{status.desc}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  </FluentShell>
);

export default PolicyApp;

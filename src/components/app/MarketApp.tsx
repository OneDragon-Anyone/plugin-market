import React from "react";
import FluentShell from "@/components/fluent/FluentShell";
import PluginExplorer from "@/components/fluent/PluginExplorer";
import type { MarketPlugin } from "@/lib/types";

interface MarketAppProps {
  plugins: MarketPlugin[];
}

export const MarketApp: React.FC<MarketAppProps> = ({ plugins }) => (
  <FluentShell activeTab="explore" pageTitle="插件市场">
    <PluginExplorer plugins={plugins} />
  </FluentShell>
);

export default MarketApp;

import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import { defineConfig } from "astro/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 站点品牌来自调用方数据仓的 policy.json：同一个引擎被多个数据仓调用，
 * 构建出的是各自的站点，所以这些值不能写在这里。
 * 读不到（本地只跑前端、CI 空构建）就注入空对象，前端回退中性默认值。
 */
function readMarketConfig() {
  const dataDir = process.env.MARKET_DATA_DIR;
  if (!dataDir) return {};
  try {
    const policy = JSON.parse(readFileSync(join(dataDir, "market", "policy.json"), "utf-8"));
    return { site: policy.site };
  } catch {
    return {};
  }
}

const marketConfig = JSON.stringify(readMarketConfig());

export default defineConfig({
  // 站点地址与 base 由部署方给：同一份引擎会构建出多个市场的站点
  site: process.env.SITE_URL,
  base: process.env.PUBLIC_BASE_PATH ?? "/",
  output: "static",
  prefetch: {
    prefetchAll: true
  },
  integrations: [
    react(),
    tailwind({
      applyBaseStyles: false
    })
  ],
  vite: {
    define: {
      // 数据仓坐标只用于拼 Issue 链接，工作流会传真实值；这里的默认值只服务本地开发
      "import.meta.env.PUBLIC_GITHUB_OWNER": JSON.stringify(process.env.PUBLIC_GITHUB_OWNER ?? "OneDragon-Anyone"),
      "import.meta.env.PUBLIC_GITHUB_REPO": JSON.stringify(process.env.PUBLIC_GITHUB_REPO ?? "plugin-data"),
      // 值本身是一段 JSON 文本，再序列化一次才是合法的字符串字面量
      "import.meta.env.PUBLIC_MARKET_CONFIG": JSON.stringify(marketConfig)
    }
  }
});

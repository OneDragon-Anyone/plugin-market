/** 目录约定：代码仓、数据仓、模板仓的落点都从这里取，环境变量在这里读一次。 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 代码仓根：本文件在 scripts/lib/ 下，往上两层 */
export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 数据仓（market/plugins、policy）与代码仓可以分离；本地开发时通过 MARKET_DATA_DIR 指向数据仓 */
export const dataDir = resolve(process.env.MARKET_DATA_DIR ?? rootDir);
export const pluginsDir = join(dataDir, "market", "plugins");
export const policyPath = join(dataDir, "market", "policy.json");

/** 构建锁与封面：跟索引一起提交，默认落在代码仓的 .lock/ */
export const lockDir = resolve(process.env.LOCK_DIR ?? join(rootDir, ".lock"));
export const lockPath = join(lockDir, "sources.lock.json");
export const lockCoversDir = join(lockDir, "covers");

/** 站点直接读的索引产物 */
export const apiDir = join(rootDir, "public", "api", "v1");

/** 模板仓检出目录：校验脚本和构建摘要看的是同一个提交 */
export const templateDir = resolve(process.env.TEMPLATE_DIR ?? ".plugin-template");

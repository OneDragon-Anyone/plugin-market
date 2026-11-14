/** 三个入口共用的运行时杂事：启动包装、临时工作目录、异常取消息。与市场业务无关。 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 异常里能取到的说法。抛出来的不一定是 Error，字符串和对象也得有个交代 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 在系统临时目录里跑一段活，结束时无论成败都清掉。
 * 前缀只用来在 /tmp 里认出是谁的，后面会拼上随机后缀。
 */
export async function withTempDir<T>(prefix: string, work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 启动入口：意外抛出的异常打到 stderr，落成这个入口约定的退出码。
 * 中间自己登记过的退出码（校验不通过之类）在正常返回时保持原样。
 */
export function run(main: () => Promise<void>, failureCode = 1): void {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = failureCode;
  });
}

/** Python 子进程通道：本仓的 Python 工具都从这里起，约定结果写在 stdout 最后一行 JSON。 */

import { spawn } from "node:child_process";

export interface PythonRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 调用方自己决定退出码怎么处理，这里只负责把进程跑完、收全输出 */
export function runPython(script: string, args: string[] = []): Promise<PythonRun> {
  const [command, ...prefix] = (process.env.PYTHON ?? "python").split(/\s+/).filter(Boolean);
  return new Promise((done, fail) => {
    const child = spawn(command, [...prefix, script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** 前面的都是日志，最后一行才是结果；没吐 JSON 说明脚本中途死了 */
export function lastJsonLine<T>(stdout: string, context: string): T {
  const line = stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) throw new Error(`${context} produced no JSON: ${line.slice(0, 200)}`);
  return JSON.parse(line) as T;
}

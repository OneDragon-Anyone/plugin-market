/**
 * 各类自动 issue 共用的正文片段：空段落折叠、issue 引用、插件名链接。
 * 新增一类 issue 时优先复用这里，不要各写一份。
 */

import type { MarketSourceEntry } from "@/lib/types";
import type { GhRepo } from "../lib/github";

/** 一段可能没有的说明 空的连前面的空行一起省掉 开新条和补评论共用这一处 */
export function paragraph(text: string): string[] {
  return text === "" ? [] : ["", text];
}

/** 汇总里点一下就跳过去 光写编号还得自己去翻 */
export function issueRef(target: string, issue: number): string {
  return `[\`#${issue}\`](https://github.com/${target}/issues/${issue})`;
}

/** 插件名链到作者仓库 和 issue 正文里的写法一致 */
export function pluginRef(entry: MarketSourceEntry, repo: GhRepo): string {
  return `[\`${entry.id}\`](${repo.html_url})`;
}

/** Actions 运行摘要：三个入口共用的拼装器。 */

import { appendFile } from "node:fs/promises";

/**
 * Actions 运行摘要：按块拼接，块之间留一个空行。
 * 本地跑没有 GITHUB_STEP_SUMMARY 时 write() 什么都不做，内容和打到终端的一样。
 */
export class StepSummary {
  private readonly blocks: string[] = [];

  constructor(title: string) {
    this.blocks.push(`## ${title}`);
  }

  /** 加粗小标题 独占一段 */
  section(label: string): this {
    this.blocks.push(`**${label}**`);
    return this;
  }

  /** 一段文字 不带前缀 */
  paragraph(text: string): this {
    if (text !== "") this.blocks.push(text);
    return this;
  }

  /** 一组列表项 自动加 "- " */
  bullets(items: string[]): this {
    if (items.length > 0) this.blocks.push(items.map((item) => `- ${item}`).join("\n"));
    return this;
  }

  /** 已经排好格式的若干行 原样收成一段 */
  raw(lines: string[]): this {
    const text = lines.filter((line) => line !== "").join("\n");
    if (text !== "") this.blocks.push(text);
    return this;
  }

  text(): string {
    return this.blocks.join("\n\n");
  }

  async write(): Promise<void> {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (!target) return;
    await appendFile(target, `${this.text()}\n`);
  }
}

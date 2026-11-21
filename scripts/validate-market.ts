/**
 * 校验入口：合并前把关，判断 PR 写进数据仓的条目到底能不能用——字段和格式对不对、
 * 仓库是否还存在、Release 里那个 `<id>.zip` 能否通过模板校验。
 * 有一样不成立就让 market/validate 检查标红，挡住这次合并。
 */

import { type GhRepo, github, orNull } from "./lib/github";
import { checkEntries, readEntryFiles, readPolicy } from "./lib/market";
import { run, withTempDir } from "./lib/runtime";
import { StepSummary } from "./lib/summary";
import { checkLatestRelease } from "./lib/validator";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 运行摘要：结论、问题清单、深度校验过的版本，写进 Actions 的 Summary。本地跑没有这个环境变量就不写 */
async function writeStepSummary(total: number, errors: string[], deep: string[]): Promise<void> {
  const summary = new StepSummary("Market validate");
  if (errors.length > 0) {
    summary.paragraph(`**Fail — ${errors.length} ${errors.length === 1 ? "problem" : "problems"}**`).bullets(errors);
  } else {
    summary.paragraph("**Pass**");
  }

  const facts = [`entries: ${total}`];
  if (deep.length > 0) facts.push(`deep: ${deep.join(", ")}`);
  summary.bullets(facts);

  await summary.write();
}

async function main(): Promise<void> {
  const policy = await readPolicy();
  const { entries, errors } = checkEntries(await readEntryFiles(), policy);
  const resolveRepos = process.argv.includes("--resolve");
  const deepIds = new Set((option("--deep") ?? "").split(",").filter(Boolean));
  const deep: string[] = [];

  if (resolveRepos || deepIds.size > 0) {
    await withTempDir("zzzod-validate-", async (workDir) => {
      for (const entry of entries) {
        if (entry.status === "removed") continue;
        const repo = await orNull(github<GhRepo>(`/repositories/${entry.repoId}`));
        if (!repo || repo.private) {
          errors.push(`${entry.id}.json: repoId ${entry.repoId} does not resolve to a public repository`);
          continue;
        }
        if (repo.full_name !== entry.repo) console.log(`INFO ${entry.id}: ${entry.repo} is now ${repo.full_name}`);
        if (!deepIds.has(entry.id)) continue;
        const result = await checkLatestRelease(repo.full_name, entry.id, policy, workDir);
        errors.push(...result.errors.map((error) => `${entry.id}: ${error}`));
        if (result.release) {
          deep.push(`${entry.id}@${result.release.tag_name}`);
          console.log(`PASS ${entry.id} ${result.release.tag_name} sha256 ${result.check?.sha256 ?? "-"}`);
        }
      }
    });
  }

  for (const error of errors) console.log(`FAIL ${error}`);
  console.log(`${errors.length === 0 ? "PASS" : "FAIL"} ${entries.length} entries checked`);
  await writeStepSummary(entries.length, errors, deep);
  if (errors.length > 0) process.exitCode = 1;
}

run(main, 2);

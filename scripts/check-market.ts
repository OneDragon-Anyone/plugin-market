import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GhRepo, github, orNull } from "./lib/github";
import { checkEntries, readEntryFiles, readPolicy } from "./lib/market";
import { checkLatestRelease } from "./lib/validator";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const policy = await readPolicy();
  const { entries, errors } = checkEntries(await readEntryFiles(), policy);
  const resolveRepos = process.argv.includes("--resolve");
  const deepIds = new Set((option("--deep") ?? "").split(",").filter(Boolean));

  if (resolveRepos || deepIds.size > 0) {
    const workDir = await mkdtemp(join(tmpdir(), "zzzod-check-"));
    try {
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
        if (result.release) console.log(`PASS ${entry.id} ${result.release.tag_name} sha256 ${result.check?.sha256 ?? "-"}`);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  for (const error of errors) console.log(`FAIL ${error}`);
  console.log(`${errors.length === 0 ? "PASS" : "FAIL"} ${entries.length} entries checked`);
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 2;
});

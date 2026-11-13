/**
 * 版本下架通知：安装包被改动或删除后，提醒作者清理 releases 页。
 * 一条 issue 对应一个未解决的问题，后续同类情况以评论追加。
 */

import type { MarketSourceEntry } from "@/lib/types";
import { assetDigest, github, orNull, closeIssue, openIssue, tryCommentIssue, type GhRelease, type GhRepo } from "../lib/github";
import type { LockPlugin, LockRelease } from "../lib/lock";
import { issueRef, paragraph, pluginRef } from "./body";

export interface RevokedNoticeOptions {
  /** 自动 issue 要写进去的仓库 空串表示这轮不发 */
  target: string;
  entry: MarketSourceEntry;
  repo: GhRepo;
  releases: GhRelease[];
  /** 这个插件还有没有可发布的版本 全下架时整条会从市场消失 */
  listed: boolean;
  lock: LockPlugin;
  log: (line: string) => void;
}

/** 附件现在到底怎么了 决定这一行怎么写 */
type RevokedKind = "deleted" | "changed" | "same" | "unknown";

interface RevokedLine {
  kind: RevokedKind;
  text: string;
}

/**
 * 每个版本一行：市场记录的是什么 GitHub 现在是什么。
 * 只有内容真的变了才走到这里 —— 重传同一份文件不算，附件被作者删掉也不算，
 * 那些都不需要他做任何事。剩下的情况分开写，免得说成「指纹对不上」这种不对的话。
 */
function describeRevoked(releases: GhRelease[], assetName: string): (tag: string, record: LockRelease) => RevokedLine {
  const liveByTag = new Map(releases.map((release) => [release.tag_name, release]));
  return (tag, record) => {
    const market = record.sha256.slice(0, 8);
    const release = liveByTag.get(tag);
    if (!release) {
      return { kind: "deleted", text: `- \`${tag}\`　市场 sha256 \`${market}\`，GitHub 上的 release 已删除` };
    }
    const asset = release.assets.find((item) => item.name === assetName);
    if (!asset) {
      return { kind: "deleted", text: `- \`${tag}\`　市场 sha256 \`${market}\`，安装包已删除` };
    }
    const digest = assetDigest(asset);
    if (digest === null) {
      return { kind: "unknown", text: `- \`${tag}\`　市场 sha256 \`${market}\`，安装包被重新上传，内容无法比对` };
    }
    if (digest !== record.sha256) {
      return { kind: "changed", text: `- \`${tag}\`　市场 sha256 \`${market}\`，GitHub 现在 \`${digest.slice(0, 8)}\`` };
    }
    // 内容一致的重传现在不下架，走不到这一行；只有判定口径改回「重传即变更」才会到，
    // 那时得说清内容相同，不能沿用上面「指纹对不上」的说法
    return { kind: "same", text: `- \`${tag}\`　市场 sha256 \`${market}\`，安装包被重新上传，内容相同` };
  };
}

/** 问题解决时写进 lock 的记号 免得每轮重复关 */
const RESOLVED_BY_CLEANUP = "leftover attachments removed";
const RESOLVED_BY_RESTORE = "attachments restored";

/**
 * 这个版本现在还有没有安装包挂在 releases 页上。
 * 列表里没有的不等于删了（一次只给 50 条），单独问一次这个 tag，404 才是真删了。
 */
async function assetStillThere(repo: string, releases: GhRelease[], assetName: string, tag: string): Promise<boolean> {
  const release =
    releases.find((item) => item.tag_name === tag) ??
    (await orNull(github<GhRelease>(`/repos/${repo}/releases/tags/${tag}`)));
  if (!release) return false;
  return release.assets.some((item) => item.name === assetName && item.state === "uploaded");
}

/** 全下架时插件整条从市场消失 得说一句 免得作者以为被删了 */
function offlineNote(listed: boolean): string {
  return listed ? "" : "这个插件现在没有可用的版本，市场页面上暂时看不到它，发了新版本就会自动回来。";
}

/** 开新 issue 的正文：先说这批版本怎么了 再逐条列指纹 最后给作者出路 */
function buildRevokedBody(
  entry: MarketSourceEntry,
  repo: GhRepo,
  lines: RevokedLine[],
  listed: boolean
): string {
  const total = lines.length;
  const broken = lines.filter((line) => line.kind === "changed" || line.kind === "unknown").length;
  // 插件名直接链到作者仓库 省得他再自己找一遍
  const name = `[${entry.id}](${repo.html_url})`;
  let intro: string;
  if (broken === total) {
    intro = `${name} 有 ${total} 个版本的安装包在收录后被动过，内容和市场记录对不上。客户端安装时会核对 sha256，对不上就装不了，所以这些版本已经下架。`;
  } else if (broken > 0) {
    intro = `${name} 有 ${total} 个版本的安装包在收录后被动过，其中 ${broken} 个的内容和市场记录对不上。客户端安装时会核对 sha256，对不上就装不了，所以这些版本已经下架。`;
  } else {
    intro = `${name} 有 ${total} 个版本的安装包在收录后被动过，市场已经不再展示这些版本。`;
  }

  // 附件还挂在 releases 页上 才值得劝他删掉；整个 release 都没了的没什么可删
  const cleanup = lines.some((line) => line.kind !== "deleted");
  // 插件整条消失时没有「其他版本」可言 只说以后的
  const scope = listed ? "其他已收录的版本" : "以后收录的版本";

  return [
    `@${repo.owner.login} 你好`,
    "",
    intro,
    "",
    ...lines.map((line) => line.text),
    "",
    ...(cleanup
      ? [
          `上面列出的这几个版本已经无法恢复，建议把它们从 [releases 页](${repo.html_url}/releases) 上删掉。`,
          "",
          "市场会定期核对，确认都删掉之后，这条 issue 将自动关闭。",
          "",
          "想继续更新的话，往后发新版本就行，内部版本号比上一个大，市场会自动收录。"
        ]
      : [
          "这些版本恢复不了 —— GitHub 上已经没有它们了，市场也不再展示。",
          "",
          "想继续更新的话，往后发新版本就行，内部版本号比上一个大，市场会自动收录。"
        ]),
    ...paragraph(offlineNote(listed)),
    "",
    `${scope}，安装包可以不用删；删掉或者拿新包盖掉，对应的版本会下架。`
  ].join("\n");
}

/**
 * 安装包内容变了之后通知作者。
 * 附件被作者删掉、重传同一份文件，这两类都不发：他自己清楚，也没有需要他处理的事。
 * 一条 issue 对应一个还没解决的问题：问题没解决之前，新下架一律在它下面补评论，
 * 哪怕这条已经被谁关掉了也不另开 —— 关闭不等于解决。
 * 留在 releases 页上的附件删掉了、或者作者把包传回来恢复了原样，才算解决（评论并关闭），
 * 之后再出问题才另开一条。
 */
export async function notifyRevoked(options: RevokedNoticeOptions): Promise<void> {
  const { target, entry, repo, releases, listed, lock, log } = options;
  if (target === "") return;
  // 已经不对外展示的插件照常下架，但不通知：作者补发新版本也回不到架上，没必要喊他来处理
  if (entry.status !== "listed") return;

  const assetName = `${entry.id}.zip`;
  const name = pluginRef(entry, repo);
  const revoked = Object.entries(lock.releases)
    .filter(([, record]) => record.revokedReason === "asset_changed")
    .sort((a, b) => a[1].versionCode - b[1].versionCode);

  const notified = new Set(lock.revokedNotified ?? []);
  const fresh = revoked.filter(([tag]) => !notified.has(tag));

  if (fresh.length > 0) {
    const describe = describeRevoked(releases, assetName);
    const lines = fresh.map(([tag, record]) => describe(tag, record));

    // 上一条还没被判定解决 就往里补评论 它现在是不是关着都不影响
    if (lock.revokedIssue !== undefined && !lock.revokedResolved) {
      const appended = await tryCommentIssue(
        target,
        lock.revokedIssue,
        [
          `又有 ${fresh.length} 个版本的安装包被重新上传或删除，已下架：`,
          "",
          ...lines.map((line) => line.text),
          ...paragraph(offlineNote(listed))
        ].join("\n")
      );
      if (appended) {
        lock.revokedNotified = revoked.map(([tag]) => tag);
        log(`- 📮 ${name} ${revoked.length} 个版本已下架，已补进 issue ${issueRef(target, lock.revokedIssue)}`);
        return;
      }
      // 404 说明那条被删了 只能另开 问题还在
      log(`- ⚠️ ${name} 之前的通知 #${lock.revokedIssue} 已不存在，另开一条`);
    }

    // 首次通知 或者上一条已经判定解决 / 被删掉：新问题单独开一条
    lock.revokedIssue = await openIssue(target, {
      title: `[revoked] ${entry.id} ${fresh.length} 个版本安装包与市场记录不一致，已下架`,
      body: buildRevokedBody(entry, repo, lines, listed),
      labels: ["revoked"]
    });
    lock.revokedNotified = revoked.map(([tag]) => tag);
    delete lock.revokedResolved;
    log(`- 📮 ${name} ${revoked.length} 个版本已下架，已开 issue ${issueRef(target, lock.revokedIssue)}`);
    return;
  }

  // 没有新下架的版本 看提醒他处理的事做完没有
  if (lock.revokedIssue === undefined || lock.revokedResolved) return;
  const issue = lock.revokedIssue;
  const resolve = async (note: string, marker: string, label: string): Promise<void> => {
    if (await tryCommentIssue(target, issue, note)) {
      await closeIssue(target, issue, "completed");
      log(`- 📮 ${name} 问题已解决（${label}），issue ${issueRef(target, issue)} 已关闭`);
    } else {
      log(`- ⚠️ ${name} 通知 #${issue} 已不存在，跳过关闭（${label}）`);
    }
    lock.revokedResolved = marker;
  };

  // 下架的版本都传回了内容一致的包，已经恢复上架，没东西要删
  if (revoked.length === 0) {
    await resolve(
      "重新上传的安装包和市场记录一致，这些版本已经恢复上架，这条关了。",
      RESOLVED_BY_RESTORE,
      "版本已恢复上架"
    );
    return;
  }
  // 还有版本挂着附件 全删掉了才算解决；没删完就每轮都报一行 让汇总里一直看得到这个插件
  // 这行不写版本数和待办细节 免得和「恢复上架」混起来 具体事项看 issue
  for (const [tag] of revoked) {
    if (await assetStillThere(repo.full_name, releases, assetName, tag)) {
      log(`- 📮 ${name} issue ${issueRef(target, issue)} 待作者处理`);
      return;
    }
  }
  await resolve("留在 releases 页上的安装包已经删掉了，这条关了。", RESOLVED_BY_CLEANUP, "安装包已删");
}

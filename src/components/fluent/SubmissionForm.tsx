import React, { useState, useMemo } from "react";
import {
  Input,
  Button,
  Field,
  Checkbox,
  Badge,
  Spinner,
  MessageBar,
  MessageBarTitle,
  MessageBarBody,
  Divider
} from "@fluentui/react-components";
import {
  Search20Regular,
  Send20Regular
} from "@fluentui/react-icons";
import { issueUrl } from "@/lib/site";
import { withBase } from "@/lib/utils";
import { RISK_TAGS, ID_PATTERN, TAG_PATTERN, MAX_TAGS, TAG_RULE_HINT } from "@/lib/types";
import { riskLabels } from "@/lib/risk";

const REPO_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

interface ManifestPreview {
  id: string;
  name: string;
  summary: string;
  version: string;
  versionCode: number | null;
  risk: string[];
}

interface ReleasePreview {
  tag: string;
  prerelease: boolean;
  size: number;
}

export const SubmissionForm: React.FC = () => {
  const [repoUrl, setRepoUrl] = useState("");
  const [tags, setTags] = useState("");
  const [confirms, setConfirms] = useState({
    maintained: false,
    released: false,
    responsibility: false
  });

  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [manifest, setManifest] = useState<ManifestPreview | null>(null);
  const [release, setRelease] = useState<ReleasePreview | null>(null);

  const parsedTags = useMemo(
    () => [
      ...new Set(
        tags
          .split(/[,，、\s]+/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      )
    ],
    [tags]
  );

  const tagError = useMemo(() => {
    if (parsedTags.length > MAX_TAGS) return `标签最多 ${MAX_TAGS} 个`;
    return parsedTags.some((t) => !TAG_PATTERN.test(t))
      ? `标签${TAG_RULE_HINT}`
      : "";
  }, [parsedTags]);

  const allConfirmed =
    confirms.maintained && confirms.released && confirms.responsibility;

  const canSubmit =
    manifest !== null && errors.length === 0 && allConfirmed && !tagError;

  async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
  }

  function errorText(e: unknown): string {
    return e instanceof Error ? e.message : "未知错误";
  }

  async function handleCheck() {
    setLoading(true);
    setErrors([]);
    setNotes([]);
    setManifest(null);
    setRelease(null);

    const errList: string[] = [];
    const noteList: string[] = [];

    try {
      const match = REPO_PATTERN.exec(repoUrl.trim());
      if (!match) {
        setErrors(["仓库地址需要是 https://github.com/<owner>/<repo> 格式。"]);
        setLoading(false);
        return;
      }
      const [, owner, name] = match;

      // 1. 确认默认分支，再获取仓库文件清单
      let ref = "";
      try {
        const repoData = (await fetchJson(
          `https://api.github.com/repos/${owner}/${name}`
        )) as { default_branch?: string; private?: boolean };
        if (repoData.private) {
          setErrors(["仓库不是公开仓库。"]);
          setLoading(false);
          return;
        }
        ref = typeof repoData.default_branch === "string" ? repoData.default_branch : "";
      } catch {
        // 拿不到默认分支时，后续请求不带 ref，由 GitHub 使用仓库默认分支
        noteList.push("无法读取仓库默认分支，已按 GitHub 默认分支继续检测。");
      }

      const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const cdnRef = ref || "master";
      let files: string[] = [];
      try {
        const jsdelivr = (await fetchJson(
          `https://data.jsdelivr.com/v1/packages/gh/${owner}/${name}@${cdnRef}?structure=flat`
        )) as { files?: { name: string }[] };
        if (Array.isArray(jsdelivr.files)) {
          files = jsdelivr.files.map((f) => f.name.replace(/^\//, ""));
        }
      } catch {
        // jsDelivr 失败走 GitHub API
        try {
          const contents = (await fetchJson(
            `https://api.github.com/repos/${owner}/${name}/contents/${refQuery}`
          )) as { name: string; type: string }[];
          files = contents.map((c) => (c.type === "dir" ? `${c.name}/` : c.name));
          noteList.push("已通过 GitHub API 获取仓库结构。");
        } catch (e) {
          setErrors([`无法访问 GitHub 仓库 ${owner}/${name}：${errorText(e)}。`]);
          setLoading(false);
          return;
        }
      }

      // 2. 检查 plugin.json 路径
      const manifests = files.filter((f) => /^[^/]+\/plugin\.json$/.test(f));
      if (manifests.length !== 1) {
        errList.push(
          `仓库根目录下应恰好有一个子目录包含 plugin.json，实际找到 ${manifests.length} 个。`
        );
      }

      if (errList.length > 0) {
        setErrors(errList);
        setLoading(false);
        return;
      }

      const manifestPath = manifests[0];
      // 3. 读取 plugin.json
      let manifestRaw: Record<string, unknown> = {};
      try {
        const contentRes = (await fetchJson(
          `https://api.github.com/repos/${owner}/${name}/contents/${manifestPath}${refQuery}`
        )) as { content?: string };
        if (typeof contentRes.content !== "string") {
          throw new Error("响应中缺少 content 字段");
        }
        const bytes = Uint8Array.from(atob(contentRes.content.replace(/\s/g, "")), (c) =>
          c.charCodeAt(0)
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("顶层不是 JSON 对象");
        }
        manifestRaw = parsed as Record<string, unknown>;
      } catch (e) {
        // 读取失败时不做后续校验，避免用空 ID 连锁报出一堆误导信息
        errList.push(
          `无法读取 plugin.json（${manifestPath}${ref ? ` @${ref}` : ""}）：${errorText(e)}。后续校验已跳过。`
        );
        return;
      }

      // 校验元数据
      const id = String(manifestRaw.id ?? "");
      if (!ID_PATTERN.test(id)) {
        errList.push(`插件 ID \`${id || "(缺失)"}\` 不合规。`);
      }
      const versionCode = manifestRaw.versionCode;
      if (typeof versionCode !== "number" || !Number.isInteger(versionCode) || versionCode <= 0) {
        errList.push("versionCode 必须为正整数。");
      }

      const parsedManifest: ManifestPreview = {
        id,
        name: String(manifestRaw.name ?? ""),
        summary: String(manifestRaw.summary ?? ""),
        version: String(manifestRaw.version ?? ""),
        versionCode: typeof versionCode === "number" ? versionCode : null,
        risk: Array.isArray(manifestRaw.risk) ? manifestRaw.risk.map(String) : []
      };
      setManifest(parsedManifest);

      // 4. 检查 Release
      try {
        const rels = (await fetchJson(
          `https://api.github.com/repos/${owner}/${name}/releases?per_page=10`
        )) as { draft: boolean; prerelease: boolean; tag_name: string; assets: { name: string; size: number }[] }[];
        const targetRel = rels.find(
          (r) => !r.draft && r.assets.some((a) => a.name === `${id}.zip`)
        );
        if (targetRel) {
          const asset = targetRel.assets.find((a) => a.name === `${id}.zip`)!;
          setRelease({
            tag: targetRel.tag_name,
            prerelease: targetRel.prerelease,
            size: asset.size
          });
        } else {
          errList.push(`未找到包含 \`${id}.zip\` 附件的已发布 Release。请确保已发布带有对应附件的 Release。`);
        }
      } catch (e) {
        noteList.push(`获取 Release 状态失败（${errorText(e)}），请确认仓库存在合规发布包。`);
      }
    } catch (e) {
      errList.push("检测过程发生异常，请检查网络或仓库地址。");
    } finally {
      setErrors(errList);
      setNotes(noteList);
      setLoading(false);
    }
  }

  function handleSubmit() {
    if (!manifest) return;
    const title = `[submission] ${manifest.name}`;
    const body = `### 仓库地址\n${repoUrl.trim()}\n\n### 补充标签\n${parsedTags.join(", ") || "无"}\n\n### 验证信息\n- ID: \`${manifest.id}\`\n- 版本: \`${manifest.version}\` (${manifest.versionCode})\n- 风险: ${manifest.risk.join(", ") || "无"}`;
    window.open(issueUrl(title, body), "_blank");
  }

  return (
    <div className="page page--narrow">
      <header className="page-header">
        <h1 className="page-title">提交插件</h1>
      </header>

      <div className="surface form-surface">
        <div className="flex items-center justify-between">
          <h2 className="section-title">仓库预检</h2>
          <a
            href={withBase("/policy/")}
            target="_blank"
            rel="noreferrer"
            className="text-caption text-secondary hover:underline"
          >
            规范要求 ↗
          </a>
        </div>

        <Field label="GitHub 仓库地址" required>
          <div className="flex flex-wrap gap-2">
            <Input
              value={repoUrl}
              onChange={(_, d) => setRepoUrl(d.value)}
              placeholder="https://github.com/your-name/your-plugin"
              className="flex-1"
              style={{ minWidth: 240 }}
            />
            <Button
              appearance="primary"
              onClick={handleCheck}
              disabled={loading || !repoUrl.trim()}
              icon={<Search20Regular />}
            >
              {loading ? "检测中..." : "预检"}
            </Button>
          </div>
        </Field>

        <Field label="补充标签（可选，以逗号或顿号分隔）" validationMessage={tagError}>
          <Input
            value={tags}
            onChange={(_, d) => setTags(d.value)}
            placeholder="如：工具、活动、补丁"
          />
        </Field>

        {loading && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Spinner size="medium" />
            <span className="text-caption">正在分析仓库结构与 Release 附件...</span>
          </div>
        )}

        {errors.length > 0 && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>检测未通过</MessageBarTitle>
              <ul className="form-error-list">
                {errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </MessageBarBody>
          </MessageBar>
        )}

        {notes.length > 0 && (
          <MessageBar intent="info">
            <MessageBarBody>
              {notes.map((n, i) => (
                <div key={i}>{n}</div>
              ))}
            </MessageBarBody>
          </MessageBar>
        )}

        {manifest && (
          <div className="form-result">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{manifest.name}</span>
              <Badge appearance="tint" color="brand">
                v{manifest.version}
              </Badge>
            </div>
            <div className="text-caption mono">ID: {manifest.id}</div>
            <p className="text-body m-0">{manifest.summary}</p>

            {release && (
              <div className="form-success text-caption flex flex-wrap gap-3 pt-1">
                <span>已找到安装包：{manifest.id}.zip</span>
                <span>标签：{release.tag}</span>
              </div>
            )}

            {manifest.risk.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {manifest.risk.map((risk) => (
                  <span key={risk} className="risk-chip">
                    {riskLabels[risk as keyof typeof riskLabels] ?? risk}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <Divider />

        <div className="space-y-2">
          <Checkbox
            checked={confirms.maintained}
            onChange={(_, d) => setConfirms((c) => ({ ...c, maintained: !!d.checked }))}
            label="确认无恶意或破坏性行为"
          />
          <Checkbox
            checked={confirms.released}
            onChange={(_, d) => setConfirms((c) => ({ ...c, released: !!d.checked }))}
            label="确认已发布合规 Release 及 ZIP 附件"
          />
          <Checkbox
            checked={confirms.responsibility}
            onChange={(_, d) => setConfirms((c) => ({ ...c, responsibility: !!d.checked }))}
            label="确认本人具有发布权限"
          />
        </div>

        <Button
          appearance="primary"
          size="large"
          className="w-full justify-center"
          disabled={!canSubmit}
          onClick={handleSubmit}
          icon={<Send20Regular />}
        >
          创建收录申请
        </Button>
      </div>
    </div>
  );
};
export default SubmissionForm;

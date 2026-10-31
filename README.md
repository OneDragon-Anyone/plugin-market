# ZZZOD 插件市场仓

自动审核插件提交、定时构建索引、渲染市场网页，并把安装包镜像到国内下载源。

- 🌐 **在线插件市场**：[https://onedragon-anyone.github.io/plugin-data/](https://onedragon-anyone.github.io/plugin-data/)
- 📦 **配套数据仓**：[OneDragon-Anyone/plugin-data](https://github.com/OneDragon-Anyone/plugin-data)（存放插件收录配置与索引）

---

## 项目结构

```text
.github/workflows/
├── reusable-build.yml            # 索引构建工作流：自动抓取 Release 并生成静态 API 与网页
├── reusable-submission-bot.yml   # 收录机器人：处理提交 Issue、校验包规范并自动提 PR
└── reusable-validate.yml         # 规则校验检查
scripts/                          # 构建、校验与机器人核心脚本 (TypeScript)
src/                              # 插件市场前端页面 (Astro + React + Fluent UI)
```

---

## 本地开发与调试

### 1. 运行网页前端
```bash
pnpm install
pnpm dev
```
打开浏览器访问本地开发服务器即可预览插件市场界面。

### 2. 本地构建与代码检查
```bash
pnpm check          # 类型与代码格式检查
pnpm build          # 前端打包构建
```

### 3. 关联数据仓联调（可选）
如需在本地使用真实插件数据进行构建测试，请将数据仓克隆至同级目录后运行：

```bash
# Windows PowerShell
$env:GITHUB_TOKEN = (gh auth token)
$env:REGISTRY_DATA_DIR = "../plugin-data"
$env:TEMPLATE_DIR = "../plugin-template"
pnpm registry:build
```

---

## 插件包国内镜像（CNB）

构建时可以把校验通过的插件 zip 原字节复制一份到 CNB 公开仓库，
再把 `plugins.json` 里的 `downloadUrl` 指向 CNB，让国内用户直接走国内源。
客户端无需改动 —— 非 `github.com` 地址会被判为 `direct` 直连。

### 数据仓侧配置

`registry/policy.json` 增加 `mirror` 块：

```json
"mirror": {
  "enabled": false,
  "repo": "OneDragon-Anyone/plugin-mirror",
  "branch": "main",
  "keepReleases": 10
}
```

`enabled: false` 时整段逻辑跳过，可安全灰度。

### 密钥

数据仓 Settings → Secrets 里加 `CNB_TOKEN`（对该镜像仓库有写权限）。
调用方 workflow 需带 `secrets: inherit` 才会传进 reusable 工作流。

可选环境变量：`CNB_MIRROR_REPO`、`CNB_API_ENDPOINT`、`CNB_MIRROR_BRANCH`。
仓库必须**公开**，否则用户匿名下载不了。

### 实现位置

| 文件 | 职责 |
|---|---|
| `scripts/lib/cnb.ts` | CNB OpenAPI 客户端：查/建 release、建 tag、申请上传地址、PUT、确认、回读校验、清理旧附件 |
| `scripts/build-registry.ts` | `publishMirror()` 新版本上传；`republishMirror()` 给缺镜像的旧版本补传 |
| `src/lib/types.ts` | `RegistryPolicy.mirror`、`WarningCode.mirror_failed` |

### 注意事项

- **必须原字节上传**：客户端强制核对 sha256，重新打包会导致安装被拒
- 上传后回读一次 `hash_value` 比对，不一致直接抛错，不写入产物
- 幂等靠锁文件的 `mirrorUrl` 字段；单次上传失败只记 `mirror_failed` 告警并回落到
  GitHub 原地址，下次构建自动补传
- 完整 PRD 见主仓 `docs/develop/plugin_mirror_prd.md`

---

## 版本与引用规范

- 数据仓通过 `@v1` 引用本仓库的可复用工作流。
- `v1` 是可移动的主版本标签：功能改进维护在 `master`，确认稳定后把 `v1` 前移到最新提交，
  消费者无需改动引用。工作流内部 `Checkout tools` 的 `ref` 也用 `v1`，保证工具代码与
  工作流文件来自同一个提交。

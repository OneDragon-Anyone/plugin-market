# ZZZOD 插件市场仓

自动审核插件提交、定时构建索引、渲染市场网页，并把索引与封面另发一份到 CNB。

- 在线插件市场：<https://onedragon-anyone.github.io/plugin-data/>
- 客户端：<https://github.com/OneDragon-Anything/ZenlessZoneZero-OneDragon>
- 模板仓：<https://github.com/OneDragon-Anyone/plugin-template>（插件参考）
- 数据仓：<https://github.com/OneDragon-Anyone/plugin-data>（插件提交）
- **市场仓**：<https://github.com/OneDragon-Anyone/plugin-market>（插件服务）

## 目录结构

```text
.github/workflows/
├── reusable-build.yml            # 索引构建工作流：自动抓取 Release 并生成静态 API 与网页
├── reusable-submission-bot.yml   # 收录机器人：处理提交 Issue、校验包规范并自动提 PR
└── reusable-validate.yml         # 规则校验检查
scripts/                          # 构建、校验与机器人核心脚本 (TypeScript)
src/                              # 插件市场前端页面 (Astro + React + Fluent UI)
```

## 本地开发与调试

### 运行网页前端

```shell
pnpm install
pnpm dev
```

打开浏览器访问本地开发服务器即可预览插件市场界面。

### 本地构建与代码检查

```shell
pnpm check          # 类型与代码格式检查
pnpm build          # 前端打包构建
```

### 关联数据仓联调（可选）

如需在本地使用真实插件数据进行构建测试，请将数据仓克隆至同级目录后运行：

```shell
# Windows PowerShell
$env:GITHUB_TOKEN = (gh auth token)
$env:MARKET_DATA_DIR = "../plugin-data"
$env:TEMPLATE_DIR = "../plugin-template"
pnpm market:build
```

产物写入站点目录下的 `public/api/`（索引、统计与封面，按 API 版本分子目录），该目录由构建生成、不入库。

## 版本与引用规范

- 数据仓引用本仓库的可复用工作流默认写 `@master`，用本仓库最新代码；想固定就换成 `@v1` 这样的 tag。这个 ref 只能写死，不能写变量。
- 工作流里检出本仓库代码用调用方 workflow 所在的提交（`job.workflow_sha`），工具代码与工作流文件不会错位。
- 模板仓坐标与 tag 由调用方传（`template_repository` / `template_ref`），本仓库不写死版本。`template_ref` 留空时自动取模板仓最新的版本 tag，取不到就让流程失败。

## 索引镜像

构建会把索引与封面另发一份到 [plugin-mirror](https://cnb.cool/OneDragon-Anyone/plugin-mirror)，与 GitHub Pages 上是同一份文件。仓库根目录的 `plugins.json` 与 `covers/` 供客户端读取。目标仓库配在数据仓 `market/policy.json` 的 `mirror.index` 里（`repo` + `branch`），凭证用环境变量 `CNB_TOKEN`，有该仓读写权限即可。没配或缺凭证时跳过镜像，构建照常出结果。

插件包不经过本仓库，默认取作者仓库的 GitHub Release 直链；作者自建镜像的写法见数据仓 README。

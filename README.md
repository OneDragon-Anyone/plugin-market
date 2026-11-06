# ZZZOD 插件市场仓

自动审核插件提交、定时构建索引、渲染市场网页，并把索引与封面镜像到国内可直读的仓库。

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
$env:MARKET_DATA_DIR = "../plugin-data"
$env:TEMPLATE_DIR = "../plugin-template"
pnpm market:build
```

产物写入站点目录下的 `public/api/`（索引、统计与封面），该目录由构建生成、不入库。

---

## 版本与引用规范

- 数据仓引用本仓库的可复用工作流时用主版本标签，标签内容随 `master` 前移，消费者无需改动引用。
- 工作流内部 `Checkout tools` 的 `ref` 用同一个标签，保证工具代码与工作流文件来自同一个提交。

---

## 国内镜像

索引与封面另发一份到 [plugin-mirror](https://cnb.cool/OneDragon-Anyone/plugin-mirror)，
仓库与分支由数据仓 `market/policy.json` 的 `mirror.index` 指定，客户端读该仓库根目录的
`plugins.json` 与 `covers/`。数据仓需配 `CNB_TOKEN`（仓库写权限）；未配或 `mirror.enabled`
写 `false` 时不镜像，不配置视为开启。

插件包不托管，一律从作者仓库的 GitHub Release 下载，安装前校验 sha256。作者自建镜像按版本
写进 `market/plugins/{id}.json`，只写自建的那几个源，`github` 由构建补：

```json
"sources": {
  "v1.2.0": {
    "github": "https://github.com/owner/repo/releases/download/v1.2.0/xxx.zip",
    "cnb": "https://cnb.cool/owner/repo/-/releases/download/v1.2.0/xxx.zip"
  }
}
```

上面 `cnb` 是作者声明的，`github` 是构建按仓库与 tag 拼的，写进数据仓会被校验拒绝。键用
`github` / `cnb` / `gitee` 时参与下载源排序，其他键只能兜底；tag 对不上已收录版本的条目会被
忽略，构建摘要里有提示。

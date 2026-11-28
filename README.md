# 插件市场引擎

市场仓提供流程与代码：收录机器人审核提交并提 PR，定时构建抓取插件 Release、产出索引与页面，再把索引和封面镜像到 CNB。插件配置和索引产物存在数据仓，插件包的校验与打包由工具仓提供。

本仓不绑定具体项目。同一份引擎可以被多个数据仓调用，各自构建自己的站点；站点品牌、客户端坐标这类信息由数据仓声明，代码里只留本地开发用的中性默认值。

## 目录结构

```text
.github/workflows/
├── reusable-build-market.yml     # 索引构建工作流：自动抓取 Release 并生成静态 API 与网页
├── reusable-submission-bot.yml   # 收录机器人：处理提交 Issue、校验包规范并自动提 PR
└── reusable-validate-market.yml  # 规则校验检查
scripts/                          # 构建、校验与机器人核心脚本 (TypeScript)
src/                              # 插件市场前端页面 (Astro + React + Fluent UI)
```

## 本地开发与调试

### 运行网页前端

```shell
pnpm install
pnpm dev
```

打开浏览器访问本地开发服务器即可预览插件市场界面。提交页的预检也在这套前端里跑：按作者仓库的默认分支读取 `plugin.json`，结果只用于提前发现问题和填好 Issue，不写进 Issue；是否收录由收录机器人在 Issue 提交后校验决定。

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
$env:TOOLS_DIR = "../plugin-tools"
pnpm market:build
```

产物写入站点目录下的 `public/api/`（索引、统计与封面，按 API 版本分子目录），该目录由构建生成、不入库。

## 索引镜像

构建会把索引与封面另发一份到 [plugin-mirror](https://cnb.cool/OneDragon-Anyone/plugin-mirror)，与 GitHub Pages 上是同一份文件。仓库根目录的 `plugins.json` 与 `covers/` 供客户端读取。目标仓库配在数据仓 `market/policy.json` 的 `mirror.index` 里（`repo` + `branch`），凭证用环境变量 `CNB_TOKEN`，有该仓读写权限即可。没配或缺凭证时跳过镜像，构建照常出结果。

插件包不经过本仓库，默认取作者仓库的 GitHub Release 直链；作者自建镜像的写法见数据仓 README。

## 工作流的接口

三个可复用工作流（定时构建、提交审核、规则校验）的配置都由调用方（数据仓）传入，包括：

- 市场仓：坐标不用传，`uses` 写哪个 tag，配的就是那个版本的脚本。
- 工具仓：坐标必填，版本 tag 留空时取该仓最新的版本 tag。插件包校验跑的就是那个仓的脚本。
- 站点地址与 base：`site_url` 不传按 GitHub Pages 的域名，`site_base_path` 不传按仓库名，部署在域名根时传 `/`。
- 索引镜像的凭证是 `CNB_TOKEN`，没配就会跳过镜像。

## 调用方的实例配置

调用方（数据仓）三块跟实例相关的内容都写在 `market/policy.json` 里，都是可选的：

```json
{
  "site": {
    "name": "ZZZ OneDragon Plugin Market",
    "logo": "OD",
    "short": "ZZZOD",
    "subtitle": "Plugins",
    "description": "发现、安装与提交 ZZZ OneDragon 插件。"
  },
  "client": {
    "lockUrls": ["https://raw.githubusercontent.com/OneDragon-Anything/ZenlessZoneZero-OneDragon/main/uv.lock"],
    "moduleRoots": ["one_dragon", "one_dragon_qt", "zzz_od"]
  },
  "templateRepository": "OneDragon-Anyone/plugin-template"
}
```

- `site.logo` / `site.short` / `site.subtitle` 组成侧栏左上角的品牌块：方块里的字、右边的粗体、粗体下面的细字。`short` 和 `subtitle` 还一起拼进浏览器标签的标题后缀（`插件市场 · ZZZOD Plugins`）。
- `site.name` 只出现在页面最底部的页脚，不参与标题，也不参与描述。
- `site.description` 是全站默认的 meta description，首页用它，其余页面各有自己的；页面上不显示，只在搜索结果和分享预览里。
- 浏览器存储键前缀不用配，由 `site.short` 小写派生（`zzzod-theme`、`zzzod-nav-collapsed`）；同一域名下挂多个市场时，简称不同就互不覆盖，改简称会让已存的主题与导航状态失效一次。
- `client.lockUrls` 是客户端依赖锁文件的 raw 直链（不要填 `github.com/.../blob/...` 这种网页地址，它返回的是 HTML，解析不出包名），目前按 `name = "..."` 行解析，适用于 uv.lock；可以填多份，包名合并成一份白名单。
- `client.moduleRoots` 是客户端自身代码的顶层包名。依赖扫描拿插件里的 import 与「客户端自带的东西」比对，锁文件只覆盖 pip 装的包，客户端自己的代码不在里面，所以得单独列出来，否则插件 import 这些模块会被当成第三方依赖报出来。OneDragon 这边是 `one_dragon`（框架核心）、`one_dragon_qt`（Qt 界面层）、`zzz_od`（本作业务层）。
- `templateRepository` 是插件模板仓的 `owner/name`。作者提交后校验没通过时，机器人在 Issue 里回的错误清单末尾会附这个链接；不配就不附那一句。

不配也能跑：品牌走中性默认值，依赖扫描只跑静态与恶意特征两类的检查，扫描结论里会注明依赖这一项没有覆盖。

前端构建读的就是这份 policy：CI 里由构建工作流把数据仓目录交给构建步骤，本地只跑前端时读不到，走默认品牌。

# 行测知识工作站

一个纯静态的个人备考站：**行测 / 申论 / 日常积累 / 模考真题**，托管在 GitHub Pages。

线上地址：https://mym2483280075.github.io/xingce-knowledge-station/

## 目录结构

| 路径 | 说明 |
|---|---|
| `index.html` | 外壳：侧栏导航 + `iframe` 承载板块页 + 顶栏全站搜索 / 计时器 / 演算入口 |
| `sections/` | 板块页：行测六大板块、申论五题型 + 范文、日常积累、每周模考（含各期次三个子页） |
| `assets/主题.js` | 主题与夜间模式，并向 `iframe` 内的板块页同步 |
| `assets/定位层.js` | 锚点跳转落位（自己算位置 → 滚动 → 复测 → 修正，避开吸顶条遮挡） |
| `assets/演算层.js` | 手写演算层（Shadow DOM 隔离，支持 Apple Pencil 压感） |
| `assets/板块页脚本.js` | **所有板块页共用**的页内交互：搜索高亮、命中面板、隐藏答案、收起卡片、目录高亮 |
| `assets/search-index.json` | 核心索引（每张卡片一条标题，约 135 KB） |
| `assets/search-full/*.json` | 分板块全文索引（19 个文件，正文切片） |
| `assets/fuse.basic.min.mjs` | 本地检索库（Fuse 7），CDN 仅作兜底 |
| `scripts/build-index.js` | 检索索引构建器 |
| `scripts/publish.py` | 发布脚本（GitHub Git Data API：比对 → 提交 → 等构建 → 回抓校验） |

## 日常维护三件事

1. **加了内容 → 重建索引**：`node scripts/build-index.js`
   （重写 `assets/search-index.json` 与 `assets/search-full/*.json`）
2. **改了板块页 HTML → 升缓存版本号**：`index.html` 里的 `CACHE_V`（当前 `v20260919b`）
   否则 iPad 会继续用缓存里的旧页面。
3. **发布**：`publish.cmd`（Codex 工作区里是 `deploy.ps1`）
   流程是「比对差异 → 只提交变化的文件 → 等 GitHub Pages 构建 → 把改动的文件回抓做字节级校验」。

> 发布**不使用 git push**：本机 `github.com:443` 时通时不通，脚本改走 `api.github.com` 的 Git Data API。

## 全站搜索的两层索引

为什么不是一个 JSON：全站正文约 120 万字，一次性下完要 1.3 MB gzip；
而绝大多数搜索命中都在标题或当前板块。所以拆两层：

| | 核心索引 | 分板块全文索引 |
|---|---|---|
| 文件 | `assets/search-index.json` | `assets/search-full/<板块>.json` |
| 粒度 | 每张卡片一条（约 1000 条） | 正文按句子切片（约 2100 片） |
| 体积 | 135 KB（gzip 17 KB） | 合计 3.9 MB（gzip 1.4 MB） |
| 加载时机 | 聚焦搜索框即加载 | 当前板块 + 标题命中板块先加载，其余按需补齐 |

命中排序：**标题精确 → 正文精确 → 模糊**；板块名/关键词命中优先，当前正在看的板块优先。
模考真题（行测各题、申论各小题）也在索引里，命中后按锚点直接跳进对应子页并高亮。

## 约定与坑

- **新增板块页**：只加一行 `<script src="../assets/板块页脚本.js?v=…">`，不要再复制内联脚本。
  页内差异（卡片选择器、按钮有无、答案结构）由脚本自动探测。
- **改了卡片结构**：同步改 `assets/板块页脚本.js` 的 `CARD_SETS` 与 `scripts/build-index.js` 的白名单，
  否则搜索会静默漏内容（不报错）。
- **改了板块页**：按上面第 2 条升 `CACHE_V`；`assets/板块页脚本.js` 自身改动时，
  所有页面的 `?v=` 也要一起升。
- **待录入槽位**：页面上的「待录入」卡片会被一起索引，补完内容后重跑索引即可被搜到。

## 内容来源

个人备考讲义与真题整理（行测六大板块讲义、申论讲义与范文、每周模考整卷）。
原始素材（知识点总结、模考识别结果、资料分析手册等）保存在本地工作区，不随站点发布。

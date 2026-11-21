# dsh-rosemary-memory

[![npm version](https://img.shields.io/npm/v/dsh-rosemary-memory.svg)](https://www.npmjs.com/package/dsh-rosemary-memory)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen.svg)](package.json)

**可审计的跨会话记忆** —— DeepSeek Harness（DSH）插件。

> 名字里的 rosemary 是「迷迭香」：记忆的香料。记住该记的，也敢忘记该忘的。

过去的会话被归纳成一条条 run / note，再按权重压成可展开的记忆单元；下个会话开头把它注入，或者随时按报错串、命令、文件名召回。**不跑模型、不上服务器、不改写原始会话记录**——同一份输入永远给出同一份结果，每一步打分都能解释。

> Auditable cross-session memory for DeepSeek Harness. Deterministic digest, weighted compression, no model calls, no server, all local.

---

## 它解决什么

DSH 的上下文插件（如 [billion-context](https://github.com/ranxianglei/billion-context)）在**会话内部**压缩：折叠出的摘要省下了 token，但会话一关，摘要也跟着消失。三个月前那次部署踩的坑，今天的会话完全不知道。

dsh-rosemary-memory 在会话之外再存一层记忆：

```
L0 原始消息 ──► L1 会话内折叠摘要（bili 的活）
                    │
                    └──► L2 run（一回合一条）──► L3 note（结论/根因/修法）
                                                    │
                                                    └──► 加权单元（相似 note 合并，权重可解释）
```

## 为什么不走向量

这是**刻意的取舍**，不是没做完。

| 向量擅长 | 工作流记忆需要 |
| --- | --- |
| 同义改写（"登录报错"≈"认证失败"） | 精确符号：`UnknownHostException`、`session-8c0b7bb4`、`lib/units.js:103` |
| 模糊主题相似 | 能解释"为什么这条被召回" |
| 一次性建索引 | 换模型不必全量重算 |

向量会把 `UnknownHostException` 和"网络错误"映射到同一个邻域，而工作流记忆最需要区分的就是这两者。所以这里用**精确匹配优先 + 字符三元组兜底**的确定性打分；真要加向量，它也只能是精确命中为 0 时的兜底层，且必须把"语义相近"写进命中原由里。

## 加权压缩（页面上的记忆列表）

原始 note 一条条读没有意义——同一条教训会在三个会话里各记一次。插件把它们折成 **unit**：

```
权重 = 频次(log, 6 次封顶)×0.35
     + 跨会话数(4 个封顶)×0.25
     + 人工权重×0.2
     + 新鲜度(45 天半衰)×0.2

相似度 = token 交集 ÷ 较短一方     # 含于关系：短句不会被长段落淹没
```

聚类里 note 数 ≥ `compactThreshold` 且合并权重 ≥ `compactWeight` 时，升级为**加权压缩条目（playbook）**：排在列表前面，展开能看到被它压缩掉的原文，**来源 note 一条不删**。

这是和"黑箱摘要"最大的区别：丢掉了什么，页面上明明白白。

## 和已有项目的关系

| | dsh-rosemary-memory | [claude-mem](https://github.com/thedotmack/claude-mem) | [Basic Memory](https://basicmemory.com) |
| --- | --- | --- | --- |
| 采集 | 解析会话原档，**零模型调用** | hooks + SDK 生成语义摘要 | 模型通过 MCP 工具写 Markdown |
| 压缩 | 相似度聚类 + 可解释权重 + 阈值可调 | 摘要 | 人工/模型整理 |
| 检索 | 确定性打分（精确优先） | 混合检索 | BM25 + 向量 |
| 依赖 | 零依赖、单进程、JSONL | Node worker + SDK | Python MCP server |
| 受众 | DSH 专用（工具 + 路由 + 槽位） | 15+ 客户端 | 任意 MCP 客户端 |

结论先摆在这：**这类工具不稀缺，稀缺的是"可审计"**。如果你要的是开箱自动、抓到就存，claude-mem 更成熟；如果你要的是"我知道它为什么记住、为什么忘记、什么时候压"，这个插件是冲着这个来的。

## 安装

### npm（推荐）

DSH 用 pnpm 管 profile，所以在这台机器上装插件 = 在自己的 profile 目录里加一个依赖。直接指向 npm 上的包：

```
cd ~/.dsh/profiles/<profile>
npm install dsh-rosemary-memory      # 或 pnpm add dsh-rosemary-memory
```

然后在同一个 `package.json` 里把包名登记进 bundles 列表：

```jsonc
{
  "dependencies": { "dsh-rosemary-memory": "^0.3.0" },
  "dsh": { "profile": { "bundles": ["...", "dsh-rosemary-memory"] } }
}
```

重载 DSH（或 `plugin_manager set_bundle enabled=false` → `true`）后，左侧栏出现「🧠 记忆」。

### 本地目录（改代码时用这个）

```
plugin_manager install_bundle  target: "D:/path/to/dsh-rosemary-memory"
```

或者手工 link 进 profile：

```jsonc
{
  "dependencies": { "dsh-rosemary-memory": "link:D:/path/to/dsh-rosemary-memory" },
  "dsh": { "profile": { "bundles": ["...", "dsh-rosemary-memory"] } }
}
```

### 从源码装

```powershell
git clone https://github.com/HZYqwq/dsh-rosemary-memory
cd dsh-rosemary-memory
python -X utf8 tools/make_repo.py --check   # 只检查，不动 git
```

包本身零依赖、无构建步骤，`node --check` 通过就能跑。

## 用法

**侧栏整页**：记忆列表（加权单元 + 权重条 + 出现次数 + 跨会话数 + 展开被压缩原文）｜阈值页（再压缩阈值、bili 上下文阈值）｜页头「归纳新回合」「重新压缩」。

**四个宿主工具**：

| 工具 | 作用 |
| --- | --- |
| `memory_digest` | 归纳（默认 dry-run，`dryRun:false` 才写） |
| `memory_recall` | 跨会话检索，返回评分与命中原由 |
| `memory_remember` | 显式写一条长期记忆（模型可主动调用的唯一写入口） |
| `memory_brief` | 可注入稳定前缀的精简摘要（默认 1200 token） |

**HTTP**（同源，手机端也能用）：

```
GET  /dsh-rosemary-memory/status          GET  /dsh-rosemary-memory/brief?budget=1200
GET  /dsh-rosemary-memory/recall?q=       GET  /dsh-rosemary-memory/notes?limit=50
POST /dsh-rosemary-memory/digest          POST /dsh-rosemary-memory/remember
GET  /dsh-rosemary-memory/units?q=        POST /dsh-rosemary-memory/compress
GET|POST /dsh-rosemary-memory/settings

旧的 `/dsh-memory/*` 前缀继续可用（别名）。
```

默认作用域是故意收窄的：`digest` 什么都不给时只归纳**最新会话**（按钮点一下不会扫全机器）；`recall` 不给 project 时搜**全部项目**；`brief` 优先当前目录，没有则回退全库。

## 阈值

| 阈值 | 默认 | 作用 |
| --- | --- | --- |
| `compactThreshold` | 2 | 多少条相似 note 才升级为压缩条目 |
| `compactWeight` | 0.4 | 合并后权重下限 |
| `similarity` | 0.55 | 相似度门槛，越高越保守 |
| `nudgeGrowthTokens` | 50000 | bili：新增多少 token 后考虑折叠 |
| `maxContextLimit` | 75% | bili：窗口用到多少比例时每轮催促折叠 |

前三个在 `data/state.json`；后两个写进 `~/.config/billion-context/billion-context.json` 的 `compress` 段（保留其他键）。bili 逐请求读取，立即生效。

## 数据

```
<插件目录>/data/
  runs.jsonl   每回合一条
  notes.jsonl  每条结论
  units.json   重新压缩的快照
  state.json   归纳时间、阈值
```

全部 append-only、可 grep、可手改。位置可用 `DSH_ROSEMARY_MEMORY_DIR`（或旧名 `DSH_MEMORY_DIR`）、或 config `storeDir` 覆盖。

**数据永远不会进仓库**：`.gitignore` 已经排除 `data/`，CI 也会在检测到 `data/` 被提交时直接失败。

## 已知边界

诚实标注，别指望它做这些：

- **没有向量检索**（理由见上）。换个说法（"登不进去" vs "认证失败"）大概率召回不到。
- **没有冲突消解**。两条互相矛盾的结论会都保留、互标 `conflicts` 并扣分，不会自动裁决谁对。
- **没有基准评测**。不像 mem0 有 LoCoMo 之类的分数，这里没有。
- **只支持 DSH**。工具、路由、槽位都是 DSH 的插件 API，换个 agent 要重写适配层。
- **界面中文优先**，英文只有 `locale/en.json` 的元数据。
- 归纳质量取决于启发式规则（问句不算结论、markdown 表格行丢弃等），会漏也会误收。

## 开发

```powershell
node --check index.js
node --check client.js
Get-ChildItem lib/*.js | ForEach-Object { node --check $_.FullName }
node scripts/smoke.mjs        # 离线跑通 digest + recall + brief
```

改 `index.js` 或 `lib/*.js` 后必须重载插件——ESM 模块缓存不会自己失效。

## License

MIT

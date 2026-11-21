# 跨会话记忆（dsh-rosemary-memory）

## 一句话

按左侧栏的「🧠 记忆」打开整页：上半是**加权压缩后**的跨会话记忆（相似 note 合并、权重可解释），下半「阈值」页能改再压缩阈值和 bili 的上下文压缩阈值。归纳是确定性的 run / note 记录，之后在任何会话里用报错串、命令、文件名把它们召回来。不跑模型，不上服务器，不改写原始会话存档。

## 为什么需要它

bili（billion-context）在**会话内部**压缩上下文：折叠出来的摘要随会话走，会话删了摘要也没了。dsh-rosemary-memory 在会话**之外**再存一层可检索记忆，让上一个会话踩过的坑能被下一个会话查到。

## 怎么用

1. **侧边栏页面**：左侧栏点「🧠 记忆」→ 「记忆」页列出加权压缩后的单元（playbook 排前，展开看被压缩掉的原文）；「阈值」页调再压缩阈值与 bili 压缩阈值。
2. **页头两个按钮**：「归纳新回合」扫描本项目已完成回合（默认最新会话，`all:true` 才全量，确定性、不跑模型）；「重新压缩」重新聚合 units 并写一份 `data/units.json` 快照。
3. **工具**：`memory_digest`（默认 dry-run）、`memory_recall`、`memory_remember`、`memory_brief`。
4. **HTTP**：`GET /dsh-rosemary-memory/status`、`POST /dsh-rosemary-memory/digest`、`GET /dsh-rosemary-memory/recall?q=`、`GET /dsh-rosemary-memory/brief`、`GET /dsh-memory/notes`、`POST /dsh-memory/remember`、`GET /dsh-memory/units?q=`、`POST /dsh-memory/compress`、`GET|POST /dsh-memory/settings`。

归纳在没有会话 id 时默认只处理**最近写入的那个会话**，不会一次扫全机器。

## 加权压缩与阈值

```
权重 = 频次(log,6次封顶)×0.35 + 跨会话数(4个封顶)×0.25 + 人工权重×0.2 + 新鲜度(45天半衰)×0.2
相似度 = token 交集 ÷ 较短一方（含于关系）
```

聚类条数 ≥ `compactThreshold` 且权重 ≥ `compactWeight` → 升级为 playbook（页面置顶，展开可见被合并的原文，来源一条不删）。三个阈值存 `data/state.json` 的 `config`；`nudgeGrowthTokens` / `maxContextLimit` 写进 `~/.config/billion-context/billion-context.json` 的 `compress` 段，与 bili 其他配置共存，逐请求生效无需重启。

## 数据在哪

- 读：`<DSH_HOME>/sessions/<project>/<session-id>/session.v4.jsonl.zstd`（多帧 zstd，逐条 JSONL），只读。
- 写：`<插件目录>/data/`（本机 `D:\deepseek\dsh-memory\data`）下的 `runs.jsonl`、`notes.jsonl`、`state.json`，append-only，可手改可 grep。可用 `DSH_MEMORY_DIR` 环境变量或 bundle config 的 `storeDir` 改位置，默认不占 C 盘。

## 打分

```
0.40 精确命中 + 0.15 trigram 相似 + 0.15 时间衰减(半衰期30天)
+ 0.10 频次(log) + 0.10 跨会话信任(1-0.5^sessionsSeen) + 0.10 人工权重
− 0.20 冲突 − 0.15 过期
```

硬过滤：项目、`active`、`staleReason`。低于 `0.35` 返回空列表，不凑数。

## 已知边界

- 归纳是规则驱动（问句、markdown 表格行、树形符号会被过滤掉），不是模型摘要；要更"聪明"的摘要仍需人力或模型介入。
- V1 不上向量，中文两字词靠 LIKE/子串兜底。
- 只读会话存档，从不回写；删除 `runs.jsonl` / `notes.jsonl` 即清空记忆。

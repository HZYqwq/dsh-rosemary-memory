# 更新日志

## 0.3.0

- **改名：`dsh-memory` → `dsh-rosemary-memory`**（rosemary 是迷迭香：记忆的香料）。包名、bundle 名、客户端模块 id、导出名全部跟着改；`/dsh-memory/*` 路由前缀保留为别名，旧书签和旧客户端 bundle 不会 404
- 环境变量：新增 `DSH_ROSEMARY_MEMORY_DIR`，旧的 `DSH_MEMORY_DIR` 继续识别
- 发布到 npm：补 `repository` / `homepage` / `bugs` / `publishConfig`，去掉 `private`，包内 18 个文件、32.8 kB（`data/` 永不打包）
- `dsh.bundle.patch.yml` 不再写死 `storeDir`，默认 `<插件目录>/data`；要换位置就加 `config: { storeDir: ... }`
- 修 `lib/units.js` 注释里一处乱码（`鈥?` → `—`）

## 0.2.0

- 记忆改成**侧边栏整页**：左栏「🧠 记忆」→ 加权记忆列表 + 阈值设置，输入框旁的按钮已移除
- 新增 `lib/units.js`：把相似 note 聚成加权单元，达到阈值的升级为「加权压缩条目」（playbook），展开可看被压缩的原文
- 新增路由：`GET /dsh-rosemary-memory/units`、`POST /dsh-rosemary-memory/compress`、`GET|POST /dsh-rosemary-memory/settings`
- 阈值可调：再压缩阈值（条数 / 权重下限 / 相似度）写 `data/state.json`；bili 上下文阈值写 `~/.config/billion-context/billion-context.json` 的 `compress` 段，保留其余键
- 记忆库默认落在**插件目录** `data/`，可用 `DSH_ROSEMARY_MEMORY_DIR` 或 config `storeDir` 覆盖
- 修复：`memory_recall` / `memory_brief` 不再把当前目录当硬过滤条件（跨项目召回会被悄悄滤空）
- 修复：`/digest` 什么都不传时只归纳**最新会话**，不再扫全机器

## 0.1.0

- 首个版本：读 DSH 会话存档（逐帧 zstd + JSONL）→ 确定性归纳成 run / note
- 四个宿主工具 `memory_digest` / `memory_recall` / `memory_remember` / `memory_brief`
- 确定性召回打分（精确 / 三元组 / 时间 / 频次 / 跨会话信任 / 人工权重）
- 全部本地 JSONL，不跑模型、不上服务器

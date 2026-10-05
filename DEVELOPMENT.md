# dsh-tool-memory 开发文档

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 项目名 | `dsh-tool-memory` |
| 定位 | DeepSeek Harness 的本地知识图谱记忆插件 |
| 版本 | v0.1.0 |
| 架构 | Cordis 插件 + `ctx.tools.register(defineTool(...))` |
| 存储 | JSONL 文件（默认 `~/.dsh/memory.jsonl`），无网络、无凭据 |
| 格式 | 与官方 MCP memory 服务器一致：实体行 `name/entityType/observations`，关系行 `from/to/relationType` |

### 1.1 目录

```text
src/store.ts         MemoryStore：加载/保存、去重、级联删除、搜索、限长
src/index.ts         9 个 defineTool 定义与插件 apply
 tests/store.spec.ts  存储层全生命周期与容错测试
 tests/tools.spec.ts  工具注册、render、写操作 kind 与端到端测试
examples/cordis.yml  dsh 组合配置示例
```

## 2. 技术决策

### 2.1 存储格式

- 每行一个 JSON 记录；读取按行解析，损坏行直接跳过。
- 依据行内形状判别类型：含 `observations` 数组按实体处理，含 `from/to/relationType` 按关系处理。
- 加载时按名称/关系键去重；保存前重写整个文件，采用临时文件 + `rename` 原子落盘。

### 2.2 工具范围

- 读：stats、read_graph、search（名称/类型/观察的子串匹配，附带相关关系）。
- 写：create_entities、add_observations、create_relations、delete_entities（级联删除关系）、delete_observations、delete_relations，全部标记 `kind: 'edit'`。
- 关系只在两端实体已存在时创建，拒绝悬挂引用并计入 `skipped`。

### 2.3 参数与限长

- 数组参数以 JSON 字符串传入（如 `entitiesJson`），解析失败或非数组直接返回 `{ ok: false, reason }`。
- 每个写操作最多 100 条输入；观察去重后写入，名称 200 字符、类型 100、观察 2000。
- 读取上限 200 实体 / 500 关系；搜索默认 20、上限 50，返回 `total` 便于续查。

## 3. 测试

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试使用 `mkdtemp` 临时目录覆盖：实体创建与 JSONL 落盘、重复/非法输入跳过、观察增删与缺失报告、关系悬挂拒绝与去重、实体级联删除、搜索命中与上限、损坏行容错、嵌套目录自动创建、读取截断，以及工具注册、render、写操作 kind 与端到端执行。

## 4. 后续方向

- 实体/观察时间戳与变更历史。
- 基于向量的语义检索（可选本地嵌入后端）。
- 多存储隔离与按命名空间切换。

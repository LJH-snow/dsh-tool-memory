# dsh-tool-memory

[English](README.md) | [中文](README.zh.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的本地知识图谱记忆 Cordis 插件。Agent 可以把实体、观察和关系存入文件型图谱，跨会话检索和管理——不依赖外部服务，也不需要任何凭据。

## 安装

```sh
npm install @libai168/dsh-tool-memory
```

需要 peer dependency：`@deepseek-ai/cordis`（^4.0.1）和 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6）。

## 配置

```yaml
- name: 'github:LJH-snow/dsh-tool-memory'
  config:
    # storagePath: '~/.dsh/memory.jsonl'
```

图谱以 JSONL 格式存储在 `storagePath`（默认 `~/.dsh/memory.jsonl`）。文件格式与官方 MCP memory 服务器一致：实体行包含 `name`/`entityType`/`observations`，关系行包含 `from`/`to`/`relationType`，已有记忆文件可以直接复用。

## 工具

| 工具 | 说明 | 写操作 |
|---|---|---|
| `memory_stats` | 报告实体、关系、观察数量和存储路径 | 否 |
| `memory_read_graph` | 读取图谱（实体、观察、关系） | 否 |
| `memory_search` | 按关键词搜索实体并附带相关关系 | 否 |
| `memory_create_entities` | 从 JSON 数组创建实体 | 是 |
| `memory_add_observations` | 为单个实体追加观察 | 是 |
| `memory_create_relations` | 在已有实体间创建关系 | 是 |
| `memory_delete_entities` | 删除实体并级联删除其关系 | 是 |
| `memory_delete_observations` | 删除指定观察 | 是 |
| `memory_delete_relations` | 删除指定关系 | 是 |

## 安全契约

- 全本地：存储层只读写一个 JSONL 文件，无网络访问、无凭据处理。
- 写入采用临时文件 + 重命名的原子方式；加载时跳过损坏行，不会让插件失效。
- 关系只能在已存在的实体之间创建，避免悬挂引用。
- 输出限长：读取最多 200 个实体、500 个关系；搜索最多 50 个实体（默认 20）；名称上限 200 字符、观察上限 2000 字符；每个写操作最多接受 100 条输入。
- 所有写操作标记为 `kind: 'edit'`；数组参数以 JSON 字符串传入并在写入前校验。

## API 范围

当前版本覆盖实体/关系/观察的完整生命周期与文件存储。时间戳、基于向量的语义搜索和多存储隔离属于后续方向。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 许可证

[MIT](LICENSE)

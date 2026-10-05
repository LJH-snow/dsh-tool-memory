# dsh-tool-memory

[English](README.md) | [中文](README.zh.md)

Local knowledge-graph memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a Cordis plugin. The agent can store entities, observations, and relations in a file-backed graph, search them, and manage them across sessions — no external service and no credentials required.

## Install

```sh
npm install @libai168/dsh-tool-memory
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies.

## Configuration

```yaml
- name: 'github:LJH-snow/dsh-tool-memory'
  config:
    # storagePath: '~/.dsh/memory.jsonl'
```

The graph is stored as JSONL at `storagePath` (default: `~/.dsh/memory.jsonl`). The file format matches the official MCP memory server shape: entity lines carry `name`/`entityType`/`observations`, relation lines carry `from`/`to`/`relationType`, so an existing memory file can be reused as-is.

## Tools

| Tool | Description | Write |
|---|---|---|
| `memory_stats` | Report entity, relation, and observation counts plus storage path | No |
| `memory_read_graph` | Read the graph (entities, observations, relations) | No |
| `memory_search` | Search entities by keyword with related relations | No |
| `memory_create_entities` | Create entities from a JSON array | Yes |
| `memory_add_observations` | Append observations to one entity | Yes |
| `memory_create_relations` | Create relations between existing entities | Yes |
| `memory_delete_entities` | Delete entities and cascade their relations | Yes |
| `memory_delete_observations` | Delete specific observations | Yes |
| `memory_delete_relations` | Delete specific relations | Yes |

## Security contract

- Everything is local: the store reads and writes one JSONL file; there is no network access and no credential handling.
- Writes are atomic (temp file + rename), and corrupt lines in an existing file are skipped on load instead of failing the plugin.
- Relations are only created between entities that already exist, preventing dangling references.
- Output is capped: reads return at most 200 entities and 500 relations, search returns at most 50 entities (default 20), names are capped at 200 characters and observations at 2,000 characters, and each mutating call accepts at most 100 input items.
- All mutating tools are marked `kind: 'edit'`; array parameters are passed as JSON strings and validated before any write.

## API scope

This version covers the full entity/relation/observation lifecycle with file storage. Timestamps, embeddings-based semantic search, and multi-store isolation are future work.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## License

[MIT](LICENSE)

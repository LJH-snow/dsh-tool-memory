import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from './store.js'

export const name = 'dsh-tool-memory'
export const inject = ['tools']

export interface MemoryPluginConfig {
  /** JSONL storage path. Defaults to ~/.dsh/memory.jsonl. */
  storagePath?: string
}

export function apply(ctx: Context, config: MemoryPluginConfig = {}) {
  const store = new MemoryStore({ storagePath: config.storagePath })
  for (const tool of createTools(store)) ctx.tools.register(tool)
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const ENTITY_RENDER_LIMIT = 100
const OBSERVATION_RENDER_LIMIT = 5

function parseJsonParam(value: unknown): unknown[] | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function renderEntity(entity: { name?: string; entityType?: string; observations?: string[] }): string {
  const observations = entity.observations ?? []
  const shown = observations.slice(0, OBSERVATION_RENDER_LIMIT).join('; ')
  const suffix = observations.length > OBSERVATION_RENDER_LIMIT ? ` ...(+${observations.length - OBSERVATION_RENDER_LIMIT})` : ''
  return `  ${entity.name ?? ''} (${entity.entityType ?? ''}) ${shown}${suffix}`
}

function renderRelation(relation: { from?: string; to?: string; relationType?: string }): string {
  return `  ${relation.from ?? ''} -[${relation.relationType ?? ''}]-> ${relation.to ?? ''}`
}

function renderGraph(value: { ok?: boolean; reason?: string; entities?: Array<{ name?: string; entityType?: string; observations?: string[] }>; relations?: Array<{ from?: string; to?: string; relationType?: string }>; truncated?: boolean }) {
  if (!value.ok) return text(value.reason ?? 'Memory graph unavailable.')
  const entities = value.entities ?? []
  const relations = value.relations ?? []
  if (!entities.length && !relations.length) return text('Memory graph is empty.')
  const lines = [
    `entities=${entities.length} relations=${relations.length}${value.truncated ? ' (truncated)' : ''}`,
    ...entities.slice(0, ENTITY_RENDER_LIMIT).map(renderEntity),
    ...(entities.length > ENTITY_RENDER_LIMIT ? [`  ... ${entities.length - ENTITY_RENDER_LIMIT} more entities omitted`] : []),
    ...relations.map(renderRelation),
  ]
  return text(lines.join('\n'))
}

function renderSearch(value: { ok?: boolean; reason?: string; entities?: Array<{ name?: string; entityType?: string; observations?: string[] }>; relations?: Array<{ from?: string; to?: string; relationType?: string }>; total?: number }) {
  if (!value.ok) return text(value.reason ?? 'Memory search failed.')
  const entities = value.entities ?? []
  if (!entities.length) return text(`No memory entries matched. total=0`)
  const lines = [
    `matched=${entities.length} total=${value.total ?? entities.length}`,
    ...entities.map(renderEntity),
    ...(value.relations ?? []).map(renderRelation),
  ]
  return text(lines.join('\n'))
}

function renderStats(value: { ok?: boolean; reason?: string; entities?: number; relations?: number; observations?: number; storagePath?: string }) {
  return value.ok
    ? text(`entities=${value.entities ?? 0} relations=${value.relations ?? 0} observations=${value.observations ?? 0} path=${value.storagePath ?? ''}`)
    : text(`Memory stats failed: ${value.reason ?? ''}`)
}

function renderWrite(value: { ok?: boolean; reason?: string } & Record<string, unknown>) {
  if (!value.ok) return text(`Memory operation failed: ${value.reason ?? ''}`)
  const summary = Object.entries(value)
    .filter(([key, item]) => key !== 'ok' && (typeof item === 'number' || typeof item === 'boolean' || Array.isArray(item)))
    .map(([key, item]) => `${key}=${Array.isArray(item) ? item.join(',') : item}`)
    .join(' ')
  return text(`Memory updated: ${summary}`)
}

export function createTools(store: MemoryStore) {
  return [
    defineTool({
      name: 'memory_stats',
      description: 'Report entity, relation, and observation counts plus the storage path of the local memory graph.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, entities: { type: 'number' }, relations: { type: 'number' }, observations: { type: 'number' }, storagePath: { type: 'string' } } },
        render: (_args, value) => renderStats(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Memory stats', kind: 'read' } },
      async execute() {
        try { return { ok: true, ...await store.stats() } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'memory_read_graph',
      description: 'Read the local memory graph (entities with observations, and relations). Output is capped.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, truncated: { type: 'boolean' }, entities: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, entityType: { type: 'string' }, observations: { type: 'array', items: { type: 'string' } } } } }, relations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { from: { type: 'string' }, to: { type: 'string' }, relationType: { type: 'string' } } } } } },
        render: (_args, value) => renderGraph(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Read memory graph', kind: 'read' } },
      async execute() {
        try { return { ok: true, ...await store.readGraph() } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'memory_search',
      description: 'Search memory entities by keyword across names, types, and observations, with related relations.',
      parameters: {
        query: { type: 'string', required: true, description: 'Case-insensitive keyword to search for' },
        limit: { type: 'integer', description: 'Maximum entities to return, 1-50 (default 20)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, total: { type: 'number' }, entities: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, entityType: { type: 'string' }, observations: { type: 'array', items: { type: 'string' } } } } }, relations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { from: { type: 'string' }, to: { type: 'string' }, relationType: { type: 'string' } } } } } },
        render: (_args, value) => renderSearch(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Search memory: ${args.query ?? ''}`, kind: 'search' } },
      async execute(args) {
        try { return { ok: true, ...await store.searchNodes(args.query as string, args.limit as number) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'memory_create_entities',
      description: 'Create memory entities. WRITE operation; entitiesJson is a JSON array of {name, entityType, observations[]}.',
      parameters: {
        entitiesJson: { type: 'string', required: true, description: 'JSON array, at most 100 entries' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, created: { type: 'number' }, skipped: { type: 'array', items: { type: 'string' } } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Create memory entities', kind: 'edit' } },
      async execute(args) {
        const inputs = parseJsonParam(args.entitiesJson)
        if (!inputs) return { ok: false, reason: 'entitiesJson must be a JSON array like [{"name":"...","entityType":"...","observations":["..."]}].' }
        try { return { ok: true, ...await store.createEntities(inputs) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'memory_add_observations',
      description: 'Append observations to one memory entity. WRITE operation; duplicates are ignored.',
      parameters: {
        name: { type: 'string', required: true, description: 'Entity name' },
        observationsJson: { type: 'string', required: true, description: 'JSON array of observation strings' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, added: { type: 'number' }, missing: { type: 'array', items: { type: 'string' } } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Add observations to ${args.name ?? ''}`, kind: 'edit' } },
      async execute(args) {
        const observations = parseJsonParam(args.observationsJson)
        if (!observations) return { ok: false, reason: 'observationsJson must be a JSON array of strings.' }
        try { return { ok: true, ...await store.addObservations(args.name as string, observations) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'memory_create_relations',
      description: 'Create relations between existing entities. WRITE operation; dangling endpoints are rejected.',
      parameters: {
        relationsJson: { type: 'string', required: true, description: 'JSON array of {from, to, relationType}' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, created: { type: 'number' }, skipped: { type: 'array', items: { type: 'string' } } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Create memory relations', kind: 'edit' } },
      async execute(args) {
        const inputs = parseJsonParam(args.relationsJson)
        if (!inputs) return { ok: false, reason: 'relationsJson must be a JSON array like [{"from":"...","to":"...","relationType":"..."}].' }
        try { return { ok: true, ...await store.createRelations(inputs) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'memory_delete_entities',
      description: 'Delete entities and cascade-delete their relations. WRITE operation.',
      parameters: {
        namesJson: { type: 'string', required: true, description: 'JSON array of entity names' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, removedEntities: { type: 'number' }, removedRelations: { type: 'number' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Delete memory entities', kind: 'edit' } },
      async execute(args) {
        const names = parseJsonParam(args.namesJson)
        if (!names) return { ok: false, reason: 'namesJson must be a JSON array of entity names.' }
        try { return { ok: true, ...await store.deleteEntities(names) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'memory_delete_observations',
      description: 'Delete specific observations from one memory entity. WRITE operation.',
      parameters: {
        name: { type: 'string', required: true, description: 'Entity name' },
        observationsJson: { type: 'string', required: true, description: 'JSON array of observation strings to remove' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, removed: { type: 'number' }, missing: { type: 'array', items: { type: 'string' } } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Delete observations from ${args.name ?? ''}`, kind: 'edit' } },
      async execute(args) {
        const observations = parseJsonParam(args.observationsJson)
        if (!observations) return { ok: false, reason: 'observationsJson must be a JSON array of strings.' }
        try { return { ok: true, ...await store.deleteObservations(args.name as string, observations) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'memory_delete_relations',
      description: 'Delete specific relations. WRITE operation.',
      parameters: {
        relationsJson: { type: 'string', required: true, description: 'JSON array of {from, to, relationType}' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, removed: { type: 'number' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Delete memory relations', kind: 'edit' } },
      async execute(args) {
        const inputs = parseJsonParam(args.relationsJson)
        if (!inputs) return { ok: false, reason: 'relationsJson must be a JSON array like [{"from":"...","to":"...","relationType":"..."}].' }
        try { return { ok: true, ...await store.deleteRelations(inputs) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),
  ]
}

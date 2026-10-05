/** File-backed knowledge-graph memory store. One JSON record per line, compatible
 * with the official MCP memory server JSONL shape: entity lines carry
 * name/entityType/observations and relation lines carry from/to/relationType. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface MemoryEntity {
  name: string
  entityType: string
  observations: string[]
}

export interface MemoryRelation {
  from: string
  to: string
  relationType: string
}

export interface MemoryGraph {
  entities: MemoryEntity[]
  relations: MemoryRelation[]
}

export interface MemoryStoreOptions {
  /** JSONL storage path. Defaults to ~/.dsh/memory.jsonl. */
  storagePath?: string
}

export interface MemoryStats {
  entities: number
  relations: number
  observations: number
  storagePath: string
}

export interface MemorySearchResult {
  entities: MemoryEntity[]
  relations: MemoryRelation[]
  total: number
}

const NAME_LIMIT = 200
const TYPE_LIMIT = 100
const OBSERVATION_LIMIT = 2000
const READ_ENTITY_LIMIT = 200
const READ_RELATION_LIMIT = 500
const SEARCH_RESULT_LIMIT = 50
const INPUT_LIMIT = 100

function asNonEmptyString(value: unknown, limit: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function relationKey(relation: MemoryRelation): string {
  return `${relation.from}\u0000${relation.to}\u0000${relation.relationType}`
}

function normalizeRelation(value: unknown): MemoryRelation | null {
  const record = asRecord(value)
  const from = asNonEmptyString(record.from, NAME_LIMIT)
  const to = asNonEmptyString(record.to, NAME_LIMIT)
  const relationType = asNonEmptyString(record.relationType, TYPE_LIMIT)
  if (!from || !to || !relationType) return null
  return { from, to, relationType }
}

function normalizeObservations(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(item => asNonEmptyString(item, OBSERVATION_LIMIT)).filter(Boolean)))
    : []
}

export class MemoryStore {
  private readonly storagePath: string

  constructor(options: MemoryStoreOptions = {}) {
    this.storagePath = options.storagePath ?? join(homedir(), '.dsh', 'memory.jsonl')
  }

  getStoragePath(): string {
    return this.storagePath
  }

  async loadGraph(): Promise<MemoryGraph> {
    let raw: string
    try {
      raw = await readFile(this.storagePath, 'utf8')
    } catch {
      return { entities: [], relations: [] }
    }
    const entities = new Map<string, MemoryEntity>()
    const relations = new Map<string, MemoryRelation>()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue }
      const record = asRecord(parsed)
      if (Array.isArray(record.observations)) {
        const name = asNonEmptyString(record.name, NAME_LIMIT)
        if (!name || entities.has(name)) continue
        entities.set(name, {
          name,
          entityType: asNonEmptyString(record.entityType, TYPE_LIMIT) || 'unknown',
          observations: normalizeObservations(record.observations),
        })
      } else if (record.from !== undefined || record.to !== undefined || record.relationType !== undefined) {
        const relation = normalizeRelation(record)
        if (relation) relations.set(relationKey(relation), relation)
      }
    }
    return { entities: [...entities.values()], relations: [...relations.values()] }
  }

  private async saveGraph(graph: MemoryGraph): Promise<void> {
    const lines = [
      ...graph.entities.map(entity => JSON.stringify(entity)),
      ...graph.relations.map(relation => JSON.stringify(relation)),
    ]
    await mkdir(dirname(this.storagePath), { recursive: true })
    const tempPath = `${this.storagePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
    await rename(tempPath, this.storagePath)
  }

  async createEntities(inputs: unknown[]): Promise<{ created: number; skipped: string[] }> {
    const graph = await this.loadGraph()
    const byName = new Map(graph.entities.map(entity => [entity.name, entity]))
    const skipped: string[] = []
    let created = 0
    for (const input of inputs.slice(0, INPUT_LIMIT)) {
      const record = asRecord(input)
      const name = asNonEmptyString(record.name, NAME_LIMIT)
      const entityType = asNonEmptyString(record.entityType, TYPE_LIMIT)
      if (!name || !entityType) {
        skipped.push(name || '(invalid)')
        continue
      }
      if (byName.has(name)) {
        skipped.push(name)
        continue
      }
      const entity: MemoryEntity = { name, entityType, observations: normalizeObservations(record.observations) }
      byName.set(name, entity)
      graph.entities.push(entity)
      created += 1
    }
    if (created) await this.saveGraph(graph)
    return { created, skipped }
  }

  async addObservations(name: string, observations: unknown[]): Promise<{ added: number; missing: string[] }> {
    const cleanName = asNonEmptyString(name, NAME_LIMIT)
    if (!cleanName) throw new Error('name is required.')
    const items = normalizeObservations(observations).slice(0, 200)
    if (!items.length) throw new Error('observations must contain at least one non-empty string.')
    const graph = await this.loadGraph()
    const entity = graph.entities.find(item => item.name === cleanName)
    if (!entity) return { added: 0, missing: [cleanName] }
    let added = 0
    for (const item of items) {
      if (!entity.observations.includes(item)) {
        entity.observations.push(item)
        added += 1
      }
    }
    if (added) await this.saveGraph(graph)
    return { added, missing: [] }
  }

  async deleteObservations(name: string, observations: unknown[]): Promise<{ removed: number; missing: string[] }> {
    const cleanName = asNonEmptyString(name, NAME_LIMIT)
    if (!cleanName) throw new Error('name is required.')
    const items = normalizeObservations(observations).slice(0, 200)
    if (!items.length) throw new Error('observations must contain at least one non-empty string.')
    const graph = await this.loadGraph()
    const entity = graph.entities.find(item => item.name === cleanName)
    if (!entity) return { removed: 0, missing: [cleanName] }
    const removeSet = new Set(items)
    const before = entity.observations.length
    entity.observations = entity.observations.filter(item => !removeSet.has(item))
    const removed = before - entity.observations.length
    if (removed) await this.saveGraph(graph)
    return { removed, missing: [] }
  }

  async deleteEntities(names: unknown[]): Promise<{ removedEntities: number; removedRelations: number }> {
    const removeSet = new Set(
      Array.isArray(names) ? names.map(item => asNonEmptyString(item, NAME_LIMIT)).filter(Boolean).slice(0, INPUT_LIMIT) : [],
    )
    if (!removeSet.size) throw new Error('names must contain at least one non-empty string.')
    const graph = await this.loadGraph()
    const entitiesBefore = graph.entities.length
    graph.entities = graph.entities.filter(entity => !removeSet.has(entity.name))
    const removedEntities = entitiesBefore - graph.entities.length
    const relationsBefore = graph.relations.length
    graph.relations = graph.relations.filter(relation => !removeSet.has(relation.from) && !removeSet.has(relation.to))
    const removedRelations = relationsBefore - graph.relations.length
    if (removedEntities || removedRelations) await this.saveGraph(graph)
    return { removedEntities, removedRelations }
  }

  async createRelations(inputs: unknown[]): Promise<{ created: number; skipped: string[] }> {
    const graph = await this.loadGraph()
    const names = new Set(graph.entities.map(entity => entity.name))
    const existing = new Set(graph.relations.map(relationKey))
    const skipped: string[] = []
    let created = 0
    for (const input of inputs.slice(0, INPUT_LIMIT)) {
      const relation = normalizeRelation(input)
      const label = relation ? `${relation.from}->${relation.to}` : '(invalid)'
      if (!relation || !names.has(relation.from) || !names.has(relation.to) || existing.has(relationKey(relation))) {
        skipped.push(label)
        continue
      }
      existing.add(relationKey(relation))
      graph.relations.push(relation)
      created += 1
    }
    if (created) await this.saveGraph(graph)
    return { created, skipped }
  }

  async deleteRelations(inputs: unknown[]): Promise<{ removed: number }> {
    const keys = new Set<string>()
    for (const input of Array.isArray(inputs) ? inputs.slice(0, INPUT_LIMIT) : []) {
      const relation = normalizeRelation(input)
      if (relation) keys.add(relationKey(relation))
    }
    if (!keys.size) throw new Error('relationsJson must contain at least one valid {from,to,relationType} object.')
    const graph = await this.loadGraph()
    const before = graph.relations.length
    graph.relations = graph.relations.filter(relation => !keys.has(relationKey(relation)))
    const removed = before - graph.relations.length
    if (removed) await this.saveGraph(graph)
    return { removed }
  }

  async readGraph(): Promise<{ graph: MemoryGraph; truncated: boolean }> {
    const graph = await this.loadGraph()
    const truncated = graph.entities.length > READ_ENTITY_LIMIT || graph.relations.length > READ_RELATION_LIMIT
    return {
      graph: {
        entities: graph.entities.slice(0, READ_ENTITY_LIMIT),
        relations: graph.relations.slice(0, READ_RELATION_LIMIT),
      },
      truncated,
    }
  }

  async searchNodes(query: string, limit?: number): Promise<MemorySearchResult> {
    const needle = asNonEmptyString(query, NAME_LIMIT).toLowerCase()
    if (!needle) throw new Error('query is required.')
    const capped = clampInt(limit, 1, SEARCH_RESULT_LIMIT) ?? 20
    const graph = await this.loadGraph()
    const matched = graph.entities.filter(entity =>
      entity.name.toLowerCase().includes(needle)
      || entity.entityType.toLowerCase().includes(needle)
      || entity.observations.some(item => item.toLowerCase().includes(needle)),
    )
    const names = new Set(matched.slice(0, capped).map(entity => entity.name))
    return {
      entities: matched.slice(0, capped),
      relations: graph.relations.filter(relation => names.has(relation.from) || names.has(relation.to)).slice(0, READ_RELATION_LIMIT),
      total: matched.length,
    }
  }

  async stats(): Promise<MemoryStats> {
    const graph = await this.loadGraph()
    return {
      entities: graph.entities.length,
      relations: graph.relations.length,
      observations: graph.entities.reduce((sum, entity) => sum + entity.observations.length, 0),
      storagePath: this.storagePath,
    }
  }
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

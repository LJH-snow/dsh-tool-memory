import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'

async function tempStore(): Promise<{ store: MemoryStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  const path = join(dir, `${randomUUID()}.jsonl`)
  return { store: new MemoryStore({ storagePath: path }), path }
}

describe('MemoryStore', () => {
  it('creates entities, skips duplicates, and persists one JSON record per line', async () => {
    const { store, path } = await tempStore()
    const result = await store.createEntities([
      { name: 'Alice', entityType: 'person', observations: ['likes tea', 'likes tea', '  '] },
      { name: 'ProjectX', entityType: 'project' },
      { name: 'Alice', entityType: 'person' },
      { name: '', entityType: 'person' },
      { name: 'NoType' },
    ])

    expect(result).toEqual({ created: 2, skipped: ['Alice', '(invalid)', 'NoType'] })
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ name: 'Alice', entityType: 'person', observations: ['likes tea'] })
    expect(JSON.parse(lines[1])).toEqual({ name: 'ProjectX', entityType: 'project', observations: [] })
    const graph = await store.readGraph()
    expect(graph.graph.entities).toEqual([
      { name: 'Alice', entityType: 'person', observations: ['likes tea'] },
      { name: 'ProjectX', entityType: 'project', observations: [] },
    ])
    expect(graph.truncated).toBe(false)
  })

  it('adds and deletes observations with missing-entity reporting', async () => {
    const { store } = await tempStore()
    await expect(store.addObservations('Ghost', ['missing'])).resolves.toEqual({ added: 0, missing: ['Ghost'] })
    await store.createEntities([{ name: 'Alice', entityType: 'person', observations: ['likes tea'] }])
    await expect(store.addObservations('Alice', ['likes coffee', 'likes tea', ''])).resolves.toEqual({ added: 1, missing: [] })
    await expect(store.deleteObservations('Alice', ['likes tea'])).resolves.toEqual({ removed: 1, missing: [] })
    await expect(store.deleteObservations('Ghost', ['x'])).resolves.toEqual({ removed: 0, missing: ['Ghost'] })
    const graph = await store.readGraph()
    expect(graph.graph.entities[0].observations).toEqual(['likes coffee'])
  })

  it('creates and deletes relations, rejecting dangling endpoints and duplicates', async () => {
    const { store } = await tempStore()
    await store.createEntities([
      { name: 'Alice', entityType: 'person' },
      { name: 'ProjectX', entityType: 'project' },
    ])
    const created = await store.createRelations([
      { from: 'Alice', to: 'ProjectX', relationType: 'works_on' },
      { from: 'Alice', to: 'Ghost', relationType: 'knows' },
      { from: 'Alice', to: 'ProjectX', relationType: 'works_on' },
      { from: 'Alice', to: 'ProjectX' },
    ])
    expect(created).toEqual({ created: 1, skipped: ['Alice->Ghost', 'Alice->ProjectX', '(invalid)'] })
    const graph = await store.readGraph()
    expect(graph.graph.relations).toEqual([{ from: 'Alice', to: 'ProjectX', relationType: 'works_on' }])
    await expect(store.deleteRelations([{ from: 'Alice', to: 'ProjectX', relationType: 'works_on' }])).resolves.toEqual({ removed: 1 })
    await expect(store.readGraph()).resolves.toMatchObject({ graph: { relations: [] } })
  })

  it('deletes entities and cascades their relations', async () => {
    const { store } = await tempStore()
    await store.createEntities([
      { name: 'Alice', entityType: 'person' },
      { name: 'Bob', entityType: 'person' },
      { name: 'ProjectX', entityType: 'project' },
    ])
    await store.createRelations([
      { from: 'Alice', to: 'ProjectX', relationType: 'works_on' },
      { from: 'Bob', to: 'ProjectX', relationType: 'works_on' },
    ])
    const result = await store.deleteEntities(['Alice'])
    expect(result).toEqual({ removedEntities: 1, removedRelations: 1 })
    const graph = await store.readGraph()
    expect(graph.graph.entities.map(entity => entity.name)).toEqual(['Bob', 'ProjectX'])
    expect(graph.graph.relations).toEqual([{ from: 'Bob', to: 'ProjectX', relationType: 'works_on' }])
  })

  it('searches names, types, and observations with limits and relations', async () => {
    const { store } = await tempStore()
    await store.createEntities(
      Array.from({ length: 60 }, (_, index) => ({ name: `Tea${index}`, entityType: 'beverage', observations: [`flavor ${index}`] })),
    )
    await store.createEntities([{ name: 'Coffee', entityType: 'beverage', observations: ['morning drink'] }])
    await store.createRelations([{ from: 'Coffee', to: 'Tea0', relationType: 'alternative_to' }])

    const defaultSearch = await store.searchNodes('tea')
    expect(defaultSearch.total).toBe(60)
    expect(defaultSearch.entities).toHaveLength(20)
    const clamped = await store.searchNodes('tea', 60)
    expect(clamped.entities).toHaveLength(50)
    const observationHit = await store.searchNodes('morning')
    expect(observationHit.entities.map(entity => entity.name)).toEqual(['Coffee'])
    expect(observationHit.relations).toEqual([{ from: 'Coffee', to: 'Tea0', relationType: 'alternative_to' }])
    await expect(store.searchNodes('   ')).rejects.toThrow('query is required.')
  })

  it('tolerates corrupt lines, empty files, and nested storage paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
    const path = join(dir, 'nested', 'deeper', 'graph.jsonl')
    const store = new MemoryStore({ storagePath: path })
    await expect(store.stats()).resolves.toMatchObject({ entities: 0, relations: 0, observations: 0 })

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not-json\n{"name":"Broken","entityType":"x"}\n{"name":"Alice","entityType":"person","observations":["ok"]}\n', 'utf8')
    const graph = await store.readGraph()
    expect(graph.graph.entities).toEqual([{ name: 'Alice', entityType: 'person', observations: ['ok'] }])
    await store.createEntities([{ name: 'Bob', entityType: 'person' }])
    const after = await store.readGraph()
    expect(after.graph.entities.map(entity => entity.name)).toEqual(['Alice', 'Bob'])
  })

  it('caps readGraph output and reports truncation', async () => {
    const { store } = await tempStore()
    await store.createEntities(Array.from({ length: 100 }, (_, index) => ({ name: `E${index}`, entityType: 't' })))
    await store.createEntities(Array.from({ length: 100 }, (_, index) => ({ name: `F${index}`, entityType: 't' })))
    await store.createEntities(Array.from({ length: 60 }, (_, index) => ({ name: `G${index}`, entityType: 't' })))

    const result = await store.readGraph()
    expect(result.truncated).toBe(true)
    expect(result.graph.entities).toHaveLength(200)
  })
})

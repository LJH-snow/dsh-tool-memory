import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import { createTools } from '../src/index.ts'

async function storeForTest(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-tools-'))
  return new MemoryStore({ storagePath: join(dir, `${randomUUID()}.jsonl`) })
}

describe('dsh-tool-memory tools', () => {
  it('registers the memory tool set', async () => {
    expect(createTools(await storeForTest()).map(tool => tool.name)).toEqual([
      'memory_stats',
      'memory_read_graph',
      'memory_search',
      'memory_create_entities',
      'memory_add_observations',
      'memory_create_relations',
      'memory_delete_entities',
      'memory_delete_observations',
      'memory_delete_relations',
    ])
  })

  it('renders graph, search, and stats output', async () => {
    const store = await storeForTest()
    await store.createEntities([{ name: 'Alice', entityType: 'person', observations: ['likes tea', 'likes coffee', 'runs', 'reads', 'codes', 'hikes'] }])
    await store.createRelations([{ from: 'Alice', to: 'ProjectX', relationType: 'works_on' }])
    const tools = createTools(store)

    const graph = tools.find(item => item.name === 'memory_read_graph')!
    const graphView = graph.output.render({}, {
      ok: true,
      entities: [{ name: 'Alice', entityType: 'person', observations: ['likes tea', 'likes coffee', 'runs', 'reads', 'codes', 'hikes'] }],
      relations: [{ from: 'Alice', to: 'ProjectX', relationType: 'works_on' }],
      truncated: false,
    }) as Array<{ text: string }>
    expect(graphView[0].text).toContain('entities=1 relations=1')
    expect(graphView[0].text).toContain('Alice (person) likes tea; likes coffee; runs; reads; codes ...(+1)')
    expect(graphView[0].text).toContain('Alice -[works_on]-> ProjectX')

    const search = tools.find(item => item.name === 'memory_search')!
    const searchView = search.output.render({}, {
      ok: true,
      total: 1,
      entities: [{ name: 'Alice', entityType: 'person', observations: ['likes tea'] }],
      relations: [],
    }) as Array<{ text: string }>
    expect(searchView[0].text).toContain('matched=1 total=1')

    const stats = tools.find(item => item.name === 'memory_stats')!
    const statsView = stats.output.render({}, { ok: true, entities: 1, relations: 1, observations: 6, storagePath: '/tmp/memory.jsonl' }) as Array<{ text: string }>
    expect(statsView[0].text).toContain('entities=1 relations=1 observations=6 path=/tmp/memory.jsonl')
  })

  it('marks every mutating tool as an edit and renders write summaries', async () => {
    const store = await storeForTest()
    const tools = createTools(store)
    const requiredArgs: Record<string, Record<string, unknown>> = {
      memory_create_entities: { entitiesJson: '[]' },
      memory_add_observations: { name: 'Alice', observationsJson: '[]' },
      memory_create_relations: { relationsJson: '[]' },
      memory_delete_entities: { namesJson: '[]' },
      memory_delete_observations: { name: 'Alice', observationsJson: '[]' },
      memory_delete_relations: { relationsJson: '[]' },
    }
    for (const [name, args] of Object.entries(requiredArgs)) {
      const tool = tools.find(item => item.name === name)!
      expect(tool.presentCall(args)).toMatchObject({ kind: 'edit' })
    }
    expect(tools.find(item => item.name === 'memory_stats')!.presentCall({})).toMatchObject({ kind: 'read' })
    expect(tools.find(item => item.name === 'memory_search')!.presentCall({ query: 'x' })).toMatchObject({ kind: 'search' })

    const create = tools.find(item => item.name === 'memory_create_entities')!
    const createView = create.output.render({}, { ok: true, created: 2, skipped: ['Alice'] }) as Array<{ text: string }>
    expect(createView[0].text).toContain('Memory updated: created=2 skipped=Alice')
    const failureView = create.output.render({}, { ok: false, reason: 'entitiesJson must be a JSON array' }) as Array<{ text: string }>
    expect(failureView[0].text).toContain('Memory operation failed: entitiesJson must be a JSON array')
  })

  it('executes create and search end to end through the tool layer', async () => {
    const store = await storeForTest()
    const tools = createTools(store)
    const create = tools.find(item => item.name === 'memory_create_entities')!
    const created = await create.execute({ entitiesJson: '[{"name":"Alice","entityType":"person","observations":["likes tea"]}]' })
    expect(created).toMatchObject({ ok: true, created: 1 })

    const badJson = await create.execute({ entitiesJson: 'not-json' })
    expect(badJson).toMatchObject({ ok: false })

    const search = tools.find(item => item.name === 'memory_search')!
    const found = await search.execute({ query: 'tea' })
    expect(found).toMatchObject({ ok: true, total: 1 })
  })
})

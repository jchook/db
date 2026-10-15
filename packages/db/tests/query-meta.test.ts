import { describe, expect, it, vi } from 'vitest'
import {
  BTreeIndex,
  DbClient,
  DeduplicatedLoadSubset,
  createCollection,
  createLiveQueryCollection,
  eq,
  getLiveQueryHash,
  getLoadSubsetDemandKey,
  prepareLiveQueryValue,
  toArray,
} from '../src'
import type {
  InitialQueryBuilder,
  LoadSubsetOptions,
  QueryMeta,
  SyncConfig,
} from '../src'

type Row = { id: number; parentId: number }
const rows: Array<Row> = [1, 2, 3, 4].map((id) => ({ id, parentId: 1 }))

function source() {
  let controls!: Parameters<SyncConfig<Row>[`sync`]>[0]
  const loads = vi.fn<(options: LoadSubsetOptions) => true>(() => true)
  const unloads = vi.fn<(options: LoadSubsetOptions) => void>()
  const collection = createCollection<Row>({
    getKey: (row) => row.id,
    syncMode: `on-demand`,
    startSync: true,
    autoIndex: `eager`,
    defaultIndexType: BTreeIndex,
    sync: {
      sync: (params) => {
        controls = params
        params.markReady()
        return { loadSubset: loads, unloadSubset: unloads }
      },
    },
  })
  const ingest = (values = rows) => {
    controls.begin()
    for (const value of values) controls.write({ type: `insert`, value })
    controls.commit()
  }
  return { collection, loads, unloads, ingest, controls }
}

describe(`query metadata`, () => {
  it(`lets an adapter skip fetching while external ingestion remains reactive`, async () => {
    const store = source()
    const fetch = vi.fn()
    store.loads.mockImplementation((options) => {
      if (options.meta?.fetchMode !== `none`) fetch()
      return true
    })
    const local = createLiveQueryCollection({
      query: (q) => q.from({ row: store.collection }),
      meta: { fetchMode: `none` },
    })
    const remote = createLiveQueryCollection({
      query: (q) => q.from({ row: store.collection }),
      meta: { fetchMode: `auto` },
    })
    await local.preload()
    expect(fetch).not.toHaveBeenCalled()
    store.ingest()
    expect(local.toArray.map(({ id, parentId }) => ({ id, parentId }))).toEqual(
      rows,
    )
    await remote.preload()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(
      remote.toArray.map(({ id, parentId }) => ({ id, parentId })),
    ).toEqual(rows)
    await local.cleanup()
    await remote.cleanup()
    await store.collection.cleanup()
  })

  it.each([`scan`, `join`, `include`, `window`] as const)(
    `retains exact metadata for %s loads, replay, release and restart`,
    async (shape) => {
      const root = source()
      const child = source()
      root.ingest()
      child.ingest()
      const meta = { route: `replica`, trace: { name: `example` } }
      const live = createLiveQueryCollection({
        query: (q) => {
          const base = q.from({ row: root.collection })
          if (shape === `join`)
            return base
              .join({ child: child.collection }, ({ row, child: item }) =>
                eq(row.id, item.parentId),
              )
              .select(({ row, child: item }) => ({
                id: item.id,
                parentId: row.id,
              }))
          if (shape === `include`)
            return base.select(({ row }) => ({
              id: row.id,
              children: toArray(
                q
                  .from({ child: child.collection })
                  .where(({ child: item }) => eq(item.parentId, row.id)),
              ),
            }))
          if (shape === `window`)
            return base.orderBy(({ row }) => row.id).limit(1)
          return base
        },
        meta,
      })
      await live.preload()
      expect(root.loads).toHaveBeenCalled()
      if (shape === `join` || shape === `include`)
        expect(child.loads).toHaveBeenCalled()
      if (shape === `window`) {
        const count = root.loads.mock.calls.length
        await live.utils.setWindow({ offset: 1, limit: 2 })
        expect(root.loads.mock.calls.length).toBeGreaterThan(count)
        expect(live.toArray.map((row) => row.id)).toEqual([2, 3])
      }
      const count = root.loads.mock.calls.length
      root.controls.begin()
      root.controls.truncate()
      for (const value of rows) root.controls.write({ type: `insert`, value })
      root.controls.commit()
      await vi.waitFor(() =>
        expect(root.loads.mock.calls.length).toBeGreaterThan(count),
      )
      await live.cleanup()
      for (const store of [root, child]) {
        for (const [options] of store.loads.mock.calls) {
          expect(options.meta).toBe(meta)
          expect(
            store.unloads.mock.calls.filter(
              ([unloaded]) => unloaded === options,
            ),
          ).toHaveLength(1)
        }
      }
      const beforeRestart = root.loads.mock.calls.length
      await live.preload()
      expect(root.loads.mock.calls.length).toBeGreaterThan(beforeRestart)
      expect(root.loads.mock.lastCall?.[0].meta).toBe(meta)
      await live.cleanup()
      await root.collection.cleanup()
      await child.collection.cleanup()
    },
  )

  it(`separates shared client preloads even with the same explicit query key`, async () => {
    const store = source()
    const client = new DbClient()
    const query = (q: InitialQueryBuilder) => q.from({ row: store.collection })
    const config = { query, queryKey: [`rows`] }
    await client.preloadLiveQuery({ ...config, meta: { route: `primary` } })
    await client.preloadLiveQuery({ ...config, meta: { route: `replica` } })
    await client.preloadLiveQuery({ ...config, meta: { route: `primary` } })
    expect(store.loads.mock.calls.map(([opts]) => opts.meta)).toEqual([
      { route: `primary` },
      { route: `replica` },
    ])
    expect(
      getLiveQueryHash(prepareLiveQueryValue(config, client), config.queryKey),
    ).toBe(
      getLiveQueryHash(
        prepareLiveQueryValue({ ...config, meta: undefined }, client),
        config.queryKey,
      ),
    )
    await client.cleanup()
    await store.collection.cleanup()
  })

  it(`scopes completed and in-flight deduplication by metadata`, async () => {
    const settle: Array<() => void> = []
    const loadSubset = vi.fn(
      () => new Promise<void>((resolve) => settle.push(resolve)),
    )
    const dedupe = new DeduplicatedLoadSubset({ loadSubset })
    const primary = dedupe.loadSubset({
      meta: { route: `primary`, priority: 1 },
    })
    expect(dedupe.loadSubset({ meta: { priority: 1, route: `primary` } })).toBe(
      primary,
    )
    const replica = dedupe.loadSubset({
      meta: { route: `replica`, priority: 1 },
    })
    expect(replica).not.toBe(primary)
    const ordinary = dedupe.loadSubset({})
    expect(loadSubset).toHaveBeenCalledTimes(3)
    settle.forEach((resolve) => resolve())
    await Promise.all([primary, replica, ordinary])
    expect(dedupe.loadSubset({ meta: { route: `primary`, priority: 1 } })).toBe(
      true,
    )
    expect(dedupe.loadSubset({})).toBe(true)
    expect(getLoadSubsetDemandKey({ meta: undefined })).toBeUndefined()
    expect(getLoadSubsetDemandKey({ meta: {} })).not.toBeUndefined()
  })

  it(`rejects unhashable metadata before starting source work`, () => {
    const store = source()
    const meta: QueryMeta = { callback: () => {} }
    expect(() =>
      createLiveQueryCollection({
        query: (q) => q.from({ row: store.collection }),
        meta,
      }),
    ).toThrow(/meta/)
    expect(store.loads).not.toHaveBeenCalled()
    void store.collection.cleanup()
  })
})

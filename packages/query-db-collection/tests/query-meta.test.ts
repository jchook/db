import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db'
import { queryCollectionOptions } from '../src'
import type { LoadSubsetOptions } from '@tanstack/db'

describe(`query metadata at the Query adapter boundary`, () => {
  it.each([`static`, `function`] as const)(
    `isolates %s cache keys, full-source coverage and releases`,
    async (keyKind) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      })
      const loads: Array<LoadSubsetOptions | undefined> = []
      const keyRequests: Array<LoadSubsetOptions> = []
      const collection = createCollection(
        queryCollectionOptions({
          queryKey:
            keyKind === `static`
              ? [`rows`]
              : (opts) => {
                  keyRequests.push(opts)
                  return [`rows`]
                },
          queryClient: client,
          syncMode: `on-demand`,
          getKey: (row: { id: number }) => row.id,
          queryFn: ({ meta }) => {
            loads.push(meta?.loadSubsetOptions)
            return Promise.resolve([{ id: 1 }, { id: 2 }])
          },
        }),
      )
      const full = createLiveQueryCollection({
        query: (q) => q.from({ row: collection }),
      })
      await full.preload()
      const primary = createLiveQueryCollection({
        query: (q) =>
          q.from({ row: collection }).where(({ row }) => eq(row.id, 1)),
        meta: { route: `primary` },
      })
      const replica = createLiveQueryCollection({
        query: (q) =>
          q.from({ row: collection }).where(({ row }) => eq(row.id, 1)),
        meta: { route: `replica` },
      })
      await primary.preload()
      await replica.preload()
      expect(loads.map((opts) => opts?.meta)).toEqual([
        undefined,
        { route: `primary` },
        { route: `replica` },
      ])
      expect(client.getQueryCache().getAll()).toHaveLength(3)
      if (keyKind === `function`) {
        expect(keyRequests.some((opts) => opts.meta?.route === `primary`)).toBe(
          true,
        )
        expect(keyRequests.some((opts) => opts.meta?.route === `replica`)).toBe(
          true,
        )
      }
      await primary.cleanup()
      expect(replica.toArray.map((row) => row.id)).toEqual([1])
      await replica.cleanup()
      await full.cleanup()
      await collection.cleanup()
      client.clear()
    },
  )
})

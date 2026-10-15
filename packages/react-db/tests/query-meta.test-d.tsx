import { expectTypeOf, test } from 'vitest'
import { createCollection, createLiveQueryCollection } from '@tanstack/db'
import { useLiveInfiniteQuery, useLiveQuery } from '../src'
import type { LoadSubsetOptions, QueryMeta } from '@tanstack/db'

declare module '@tanstack/db' {
  interface Register {
    queryMeta: {
      fetchMode?: `none` | `auto`
      route?: string
      [key: string]: unknown
    }
  }
}

test(`registered metadata is shared by core, React hooks and adapters`, () => {
  expectTypeOf<LoadSubsetOptions[`meta`]>().toEqualTypeOf<
    QueryMeta | undefined
  >()
  const collection = createCollection({
    getKey: (row: { id: number }) => row.id,
    sync: {
      sync: ({ markReady }) => {
        markReady()
        return {
          loadSubset: (options) => {
            expectTypeOf(options.meta?.fetchMode).toEqualTypeOf<
              `none` | `auto` | undefined
            >()
            return true
          },
        }
      },
    },
  })
  const core = createLiveQueryCollection({
    query: (q) => q.from({ row: collection }),
    meta: { fetchMode: `none` },
  })
  expectTypeOf(core.toArray[0]!.id).toEqualTypeOf<number>()
  useLiveQuery({
    query: (q) => q.from({ row: collection }),
    meta: { route: `replica` },
  })
  useLiveInfiniteQuery(
    (q) => q.from({ row: collection }).orderBy(({ row }) => row.id),
    {
      meta: { fetchMode: `none` },
      pageSize: 10,
    },
  )
  // @ts-expect-error Invalid values cannot enter the registered metadata type.
  const invalid: QueryMeta = { fetchMode: `invalid` }
  void invalid
})

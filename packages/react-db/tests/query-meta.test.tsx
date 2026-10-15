import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { BTreeIndex, DbClient, createCollection } from '@tanstack/db'
import { useLiveInfiniteQuery, useLiveQuery } from '../src'
import type { InitialQueryBuilder, LoadSubsetOptions } from '@tanstack/db'

function source() {
  const loads = vi.fn<(opts: LoadSubsetOptions) => true | Promise<void>>(
    () => true,
  )
  const unloads = vi.fn<(opts: LoadSubsetOptions) => void>()
  const collection = createCollection({
    getKey: (row: { id: number }) => row.id,
    syncMode: `on-demand`,
    autoIndex: `eager`,
    defaultIndexType: BTreeIndex,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        begin()
        for (let id = 1; id <= 8; id++) write({ type: `insert`, value: { id } })
        commit()
        markReady()
        return { loadSubset: loads, unloadSubset: unloads }
      },
    },
  })
  return { collection, loads, unloads }
}

describe(`query metadata in React`, () => {
  it(`retires a pending metadata scope without failing its replacement`, async () => {
    const store = source()
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_, fail) => {
      reject = fail
    })
    store.loads.mockImplementation((opts) =>
      opts.meta?.route === `primary` ? pending : true,
    )
    const { result, rerender, unmount } = renderHook(
      ({ route }) =>
        useLiveQuery({
          query: (q) => q.from({ row: store.collection }),
          queryKey: [`held`],
          meta: { route },
        }),
      { initialProps: { route: `primary` } },
    )
    await waitFor(() => expect(store.loads).toHaveBeenCalled())
    const request = store.loads.mock.calls[0]![0]
    expect(result.current.isReady).toBe(false)
    rerender({ route: `replica` })
    await waitFor(() => expect(result.current.isReady).toBe(true))
    await waitFor(() => expect(request.signal?.aborted).toBe(true))
    await act(async () => {
      reject(new Error(`retired request`))
      await Promise.resolve()
    })
    expect(result.current.isReady).toBe(true)
    expect(result.current.isError).toBe(false)
    expect(store.unloads.mock.calls.map(([opts]) => opts)).toContain(request)
    unmount()
    await result.current.collection.cleanup()
    await store.collection.cleanup()
  })

  it.each([`derived`, `queryKey`, `deps`] as const)(
    `changes adapter context with %s identity and releases the prior subscription`,
    async (identity) => {
      const store = source()
      const client = new DbClient()
      const { result, rerender, unmount } = renderHook(
        ({ route }) => {
          const options = {
            query: (q: InitialQueryBuilder) =>
              q.from({ row: store.collection }),
            meta: { route },
            client,
            ...(identity === `queryKey` ? { queryKey: [`rows`] } : {}),
          }
          return useLiveQuery(
            options,
            ...((identity === `deps` ? [[]] : []) as [] | [Array<unknown>]),
          )
        },
        {
          initialProps: { route: `primary` },
        },
      )
      await waitFor(() => expect(result.current.isReady).toBe(true))
      const firstCollection = result.current.collection
      const first = store.loads.mock.calls.map(([opts]) => opts)
      expect(first.length).toBeGreaterThan(0)
      expect(first.every((opts) => opts.meta?.route === `primary`)).toBe(true)
      rerender({ route: `primary` })
      expect(result.current.collection).toBe(firstCollection)
      rerender({ route: `replica` })
      await waitFor(() => expect(result.current.isReady).toBe(true))
      expect(result.current.collection).not.toBe(firstCollection)
      expect(store.loads.mock.lastCall?.[0].meta).toEqual({ route: `replica` })
      await waitFor(() =>
        expect(store.unloads.mock.calls.map(([opts]) => opts)).toEqual(
          expect.arrayContaining(first),
        ),
      )
      unmount()
      await result.current.collection.cleanup()
      await store.collection.cleanup()
    },
  )

  it.each([false, true])(
    `carries metadata through infinite pages and resets on change (explicit key: %s)`,
    async (explicit) => {
      const store = source()
      const { result, rerender, unmount } = renderHook(
        ({ route }) =>
          useLiveInfiniteQuery(
            (q) =>
              q.from({ row: store.collection }).orderBy(({ row }) => row.id),
            {
              pageSize: 2,
              meta: { route },
              ...(explicit ? { queryKey: [`pages`] } : {}),
            },
          ),
        { initialProps: { route: `primary` } },
      )
      await waitFor(() => expect(result.current.isReady).toBe(true))
      expect(result.current.data.map((row) => row.id)).toEqual([1, 2])
      const first = result.current.collection
      rerender({ route: `primary` })
      expect(result.current.collection).toBe(first)
      const count = store.loads.mock.calls.length
      await act(() => result.current.fetchNextPage())
      expect(result.current.data.map((row) => row.id)).toEqual([1, 2, 3, 4])
      expect(store.loads.mock.calls.length).toBeGreaterThan(count)
      expect(
        store.loads.mock.calls.every(
          ([opts]) => opts.meta?.route === `primary`,
        ),
      ).toBe(true)
      rerender({ route: `replica` })
      await waitFor(() => expect(result.current.isReady).toBe(true))
      expect(result.current.collection).not.toBe(first)
      expect(result.current.pages).toHaveLength(1)
      expect(store.loads.mock.lastCall?.[0].meta).toEqual({ route: `replica` })
      unmount()
      await result.current.collection?.cleanup()
      await store.collection.cleanup()
    },
  )
})

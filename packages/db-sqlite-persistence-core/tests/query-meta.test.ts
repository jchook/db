import { describe, expect, it } from 'vitest'
import { getLoadSubsetDemandKey } from '@tanstack/db'
import {
  toProcessLocalLoadSubsetOptions,
  toTransportedLoadSubsetOptions,
  validateRemoteSubsetOptions,
} from '../src/remote-subset-wire'

describe(`query metadata transport`, () => {
  it(`preserves metadata and demand identity across the coordinator wire`, () => {
    const options = {
      meta: {
        route: `replica`,
        diagnostics: { label: `example`, priority: 2 },
      },
      limit: 5,
    }
    validateRemoteSubsetOptions(options)
    const wire = toTransportedLoadSubsetOptions(options)
    expect(wire.meta).toEqual(options.meta)
    expect(wire.meta).not.toBe(options.meta)
    expect(getLoadSubsetDemandKey({ meta: wire.meta, limit: wire.limit })).toBe(
      getLoadSubsetDemandKey(options),
    )
    const local = toProcessLocalLoadSubsetOptions(options, wire)
    expect(local.meta).toEqual(options.meta)
    expect(
      getLoadSubsetDemandKey({ limit: wire.limit, meta: { route: `primary` } }),
    ).not.toBe(getLoadSubsetDemandKey(options))
  })
})

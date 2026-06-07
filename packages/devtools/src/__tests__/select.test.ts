// select — pure unit coverage for the clock-free `convergence` rollup and the
// clock-injected `stalledDocs` staleness hint. Built from `ObsEvent` literals
// fed through `model.ingest` — no Exchange, no real clock, no `drain`.

import type { ObsEvent } from "@kyneta/exchange"
import { describe, expect, it } from "vitest"
import { convergence, stalledDocs } from "../select.js"
import { createWorldModel } from "../world.js"

/** A model plus a seq-stamping ingest for terse `ObsEvent` literals. */
function makeModel() {
  const model = createWorldModel()
  let seq = 0
  const ingest = (body: Record<string, unknown>): void => {
    model.ingest({ v: 1, seq: seq++, t: 0, peerId: "a", ...body } as ObsEvent)
  }
  const syncState = (docId: string, peer: string, state: string): void => {
    ingest({ layer: "directory", kind: "sync-state", docId, peer, state })
  }
  return { model, ingest, syncState }
}

describe("convergence (clock-free units)", () => {
  it("all-synced → converged", () => {
    const { model, syncState } = makeModel()
    syncState("d1", "bob", "synced")
    syncState("d2", "bob", "synced")
    expect(convergence(model)).toMatchObject({
      state: "converged",
      pending: 0,
      pendingDocs: [],
      stuckDocs: [],
      errors: 0,
    })
    model.dispose()
  })

  it("vacant-only → converged (vacant is terminal/non-blocking)", () => {
    const { model, syncState } = makeModel()
    syncState("d1", "bob", "vacant")
    expect(convergence(model).state).toBe("converged")
    model.dispose()
  })

  it("≥1 pending + no error → syncing", () => {
    const { model, syncState } = makeModel()
    syncState("d1", "bob", "pending")
    syncState("d2", "bob", "synced")
    expect(convergence(model)).toMatchObject({
      state: "syncing",
      pending: 1,
      pendingDocs: ["d1"],
      stuckDocs: [],
      errors: 0,
    })
    model.dispose()
  })

  it("≥1 pending + a warning diagnostic → still syncing (warnings don't gate)", () => {
    const { model, ingest, syncState } = makeModel()
    syncState("d1", "bob", "pending")
    ingest({
      layer: "diagnostic",
      kind: "diagnostic",
      code: "protocol-skew",
      severity: "warning",
      peer: "bob",
      local: "v1.0",
      remote: "v1.1",
      message: "minor skew",
    })
    expect(convergence(model)).toMatchObject({
      state: "syncing",
      errors: 0,
      diagnostics: 1,
      stuckDocs: [],
    })
    model.dispose()
  })

  it("doc-scoped error on a pending doc → stuck, doc attributed in stuckDocs", () => {
    const { model, ingest, syncState } = makeModel()
    syncState("d1", "bob", "pending")
    syncState("d2", "bob", "pending") // pending, but no error → not stuck
    ingest({
      layer: "diagnostic",
      kind: "diagnostic",
      code: "schema-hash-mismatch",
      severity: "error",
      peer: "bob",
      docId: "d1",
      local: "h1",
      remote: "h2",
      message: "hash mismatch",
    })
    expect(convergence(model)).toMatchObject({
      state: "stuck",
      pending: 2,
      pendingDocs: ["d1", "d2"],
      stuckDocs: ["d1"],
      errors: 1,
    })
    model.dispose()
  })

  it("peer-scoped error (no docId) → global stuck with empty stuckDocs", () => {
    const { model, ingest, syncState } = makeModel()
    syncState("d1", "bob", "pending")
    ingest({
      layer: "diagnostic",
      kind: "diagnostic",
      code: "protocol-mismatch",
      severity: "error",
      peer: "bob",
      local: "v1",
      remote: "v2",
      message: "incompatible",
    })
    expect(convergence(model)).toMatchObject({
      state: "stuck",
      stuckDocs: [],
      errors: 1,
    })
    model.dispose()
  })

  it("pending === 0 wins: an error on an already-synced doc still reads converged", () => {
    const { model, ingest, syncState } = makeModel()
    syncState("d1", "bob", "synced")
    ingest({
      layer: "diagnostic",
      kind: "diagnostic",
      code: "schema-hash-mismatch",
      severity: "error",
      peer: "bob",
      docId: "d1",
      local: "h1",
      remote: "h2",
      message: "stale error",
    })
    expect(convergence(model)).toMatchObject({
      state: "converged",
      pending: 0,
      stuckDocs: [],
      errors: 1,
    })
    model.dispose()
  })
})

describe("stalledDocs (injected clock units)", () => {
  it("returns a pending doc whose latest event is older than now - quietMs", () => {
    const { model, ingest } = makeModel()
    // d1 pending, last activity at t=100 (stale); d2 pending, recent at t=900;
    // d3 synced (never returned regardless of age).
    ingest({
      layer: "directory",
      kind: "sync-state",
      docId: "d1",
      peer: "bob",
      state: "pending",
      t: 100,
    })
    ingest({
      layer: "directory",
      kind: "sync-state",
      docId: "d2",
      peer: "bob",
      state: "pending",
      t: 900,
    })
    ingest({
      layer: "directory",
      kind: "sync-state",
      docId: "d3",
      peer: "bob",
      state: "synced",
      t: 100,
    })
    expect(stalledDocs(model, { now: 1000, quietMs: 500 })).toEqual(["d1"])
    model.dispose()
  })

  it("a more recent event for a pending doc clears the stall", () => {
    const { model, ingest } = makeModel()
    ingest({
      layer: "directory",
      kind: "sync-state",
      docId: "d1",
      peer: "bob",
      state: "pending",
      t: 100,
    })
    // A later event for the same doc raises its latest `t` past the threshold.
    ingest({
      layer: "doc",
      kind: "changeset",
      docId: "d1",
      replay: true,
      ops: [],
      t: 950,
    })
    expect(stalledDocs(model, { now: 1000, quietMs: 500 })).toEqual([])
    model.dispose()
  })
})

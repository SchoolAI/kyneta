// store.test.ts — Tier 1 pure store tests (no React, no jsdom).
//
// Tests createChangefeedStore and createSyncStore independently of React.
// Uses createDoc + batch() from @kyneta/schema/basic — no renderHook,
// no jsdom, fast execution.

import { createReactiveMap } from "@kyneta/changefeed"
import type { PeerIdentityDetails, SyncRef } from "@kyneta/exchange"
import { batch, createDoc, Schema } from "@kyneta/schema/basic"
import { describe, expect, it, vi } from "vitest"
import {
  createChangefeedStore,
  createDerivedSyncStore,
  createNullishStore,
  createSyncStore,
} from "../store.js"

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const TestSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
    }),
  ),
})

// ---------------------------------------------------------------------------
// createChangefeedStore
// ---------------------------------------------------------------------------

describe("createChangefeedStore", () => {
  it("returns initial snapshot from a scalar ref", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)
    expect(store.getSnapshot()).toBe("")
  })

  it("returns initial snapshot from a composite ref", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)
    expect(store.getSnapshot()).toEqual({
      title: "",
      count: 0,
      items: [],
    })
  })

  it("updates snapshot when changefeed fires on a scalar", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    batch(doc, d => {
      d.title.set("hello")
    })

    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe("hello")
  })

  it("snapshot is referentially stable between getSnapshot calls", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)

    const snap1 = store.getSnapshot()
    const snap2 = store.getSnapshot()
    expect(snap1).toBe(snap2) // same reference
  })

  it("snapshot identity changes after a mutation", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)

    const before = store.getSnapshot()

    store.subscribe(() => {})
    batch(doc, d => {
      d.title.set("changed")
    })

    const after = store.getSnapshot()
    expect(before).not.toBe(after)
    expect(after.title).toBe("changed")
  })

  it("deep subscription on composite ref fires on nested field change", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    batch(doc, d => {
      d.title.set("nested change")
    })

    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().title).toBe("nested change")
  })

  it("deep subscription fires on sequence push", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)

    store.subscribe(() => {})

    batch(doc, d => {
      d.items.push({ name: "first" })
    })

    expect(store.getSnapshot().items).toEqual([{ name: "first" }])
  })

  it("leaf subscription does not fire when a sibling field changes", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    // Mutate a sibling field — title's changefeed should NOT fire
    batch(doc, d => {
      d.count.set(42)
    })

    expect(onStoreChange).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe("") // unchanged
  })

  it("unsubscribe stops snapshot updates", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)

    const onStoreChange = vi.fn()
    const unsub = store.subscribe(onStoreChange)

    batch(doc, d => {
      d.title.set("first")
    })
    expect(store.getSnapshot()).toBe("first")

    unsub()

    batch(doc, d => {
      d.title.set("second")
    })

    // After unsubscribe, the store's cached snapshot is stale
    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe("first")
  })

  it("works with sequence ref", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.items)

    store.subscribe(() => {})

    expect(store.getSnapshot()).toEqual([])

    batch(doc, d => {
      d.items.push({ name: "a" })
    })

    batch(doc, d => {
      d.items.push({ name: "b" })
    })

    const snapshot = store.getSnapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot.map((i: any) => i.name)).toContain("a")
    expect(snapshot.map((i: any) => i.name)).toContain("b")
  })

  it("supports multiple independent subscribers", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)

    const onA = vi.fn()
    const onB = vi.fn()
    const unsubA = store.subscribe(onA)
    const unsubB = store.subscribe(onB)

    batch(doc, d => {
      d.title.set("both")
    })

    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe("both")

    // Unsubscribe A — B should still fire independently
    unsubA()

    batch(doc, d => {
      d.title.set("only-b")
    })

    expect(onA).toHaveBeenCalledTimes(1) // no new call
    expect(onB).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toBe("only-b")

    unsubB()
  })
})

// ---------------------------------------------------------------------------
// createChangefeedStore with ReactiveMap
// ---------------------------------------------------------------------------

describe("createChangefeedStore with ReactiveMap", () => {
  it("returns initial snapshot of empty map", () => {
    const [map] = createReactiveMap<string, number>()
    const store = createChangefeedStore(map)
    const snapshot = store.getSnapshot()
    expect(snapshot).toBeInstanceOf(Map)
    expect(snapshot.size).toBe(0)
  })

  it("snapshot identity changes after mutation + emit", () => {
    const [map, handle] = createReactiveMap<string, number>()
    const store = createChangefeedStore(map)
    const unsub = store.subscribe(() => {})

    const before = store.getSnapshot()

    handle.set("a", 1)
    handle.emit({ changes: [{ type: "set" }] })

    const after = store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.get("a")).toBe(1)

    unsub()
  })

  it("getSnapshot returns stable reference between emits", () => {
    const [map] = createReactiveMap<string, number>()
    const store = createChangefeedStore(map)
    const unsub = store.subscribe(() => {})

    const snap1 = store.getSnapshot()
    const snap2 = store.getSnapshot()
    expect(snap1).toBe(snap2)

    unsub()
  })
})

// ---------------------------------------------------------------------------
// createNullishStore
// ---------------------------------------------------------------------------

describe("createNullishStore", () => {
  it("returns the nullish value and subscribe is a safe no-op", () => {
    const nullStore = createNullishStore(null)
    expect(nullStore.getSnapshot()).toBe(null)

    const undefStore = createNullishStore(undefined)
    expect(undefStore.getSnapshot()).toBe(undefined)

    // subscribe returns a callable unsubscribe, never throws
    nullStore.subscribe(() => {})()
  })
})

// ---------------------------------------------------------------------------
// createSyncStore
// ---------------------------------------------------------------------------

// Stateful mock SyncRef: `_emit` mutates the surface (peerStates / ready /
// reconciled identities) and notifies subscribers, mirroring how the real
// SyncRef updates on a peer-sync change.
type MockSyncRef = SyncRef & {
  _emit: (next: {
    peerStates?: any[]
    ready?: boolean
    reconciled?: PeerIdentityDetails[]
  }) => void
}

function createMockSyncRef(): MockSyncRef {
  const listeners = new Set<(peerStates: any[]) => void>()
  let peerStates: any[] = []
  let ready = false
  let reconciled: PeerIdentityDetails[] = []

  return {
    peerId: "test-peer",
    docId: "test-doc",
    get peerStates() {
      return peerStates
    },
    get ready() {
      return ready
    },
    readyFor(pred: (p: PeerIdentityDetails) => boolean) {
      return reconciled.some(pred)
    },
    connectivity: "connecting",
    waitForSync: () => Promise.resolve(),
    settled: () => Promise.resolve({ via: "peer" as const }),
    onPeerSyncChange(cb: (peerStates: any[]) => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    _emit(next) {
      if (next.peerStates !== undefined) peerStates = next.peerStates
      if (next.ready !== undefined) ready = next.ready
      if (next.reconciled !== undefined) reconciled = next.reconciled
      for (const cb of listeners) cb(peerStates)
    },
  }
}

describe("createSyncStore", () => {
  it("returns initial peerStates", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)
    expect(store.getSnapshot()).toEqual([])
  })

  it("updates snapshot on peer-sync change", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    const newStates = [
      { docId: "test-doc", peer: { peerId: "peer-1" }, state: "synced" },
    ]
    syncRef._emit({ peerStates: newStates })

    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe(newStates)
  })

  it("unsubscribe stops updates", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)

    const onStoreChange = vi.fn()
    const unsub = store.subscribe(onStoreChange)

    unsub()

    syncRef._emit({
      peerStates: [
        { docId: "test-doc", peer: { peerId: "peer-1" }, state: "synced" },
      ],
    })

    expect(onStoreChange).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toEqual([]) // still initial
  })
})

describe("createDerivedSyncStore", () => {
  it("array select returns peerStates", () => {
    const syncRef = createMockSyncRef()
    const store = createDerivedSyncStore(syncRef, ref => ref.peerStates)
    store.subscribe(() => {})
    const states = [
      { docId: "test-doc", peer: { peerId: "peer-1" }, state: "synced" },
    ]
    syncRef._emit({ peerStates: states })
    expect(store.getSnapshot()).toBe(states)
  })

  it("boolean (ready) select latches true and does NOT regress on a flip back to pending", () => {
    const syncRef = createMockSyncRef()
    const store = createDerivedSyncStore(syncRef, ref => ref.ready)
    store.subscribe(() => {})
    expect(store.getSnapshot()).toBe(false)

    // First reconciliation: ready latches true.
    syncRef._emit({
      ready: true,
      peerStates: [
        { docId: "test-doc", peer: { peerId: "peer-1" }, state: "synced" },
      ],
    })
    expect(store.getSnapshot()).toBe(true)

    // Reconnect re-handshake: the live per-peer state flips back to pending,
    // but `ready` stays latched (the mock keeps ready=true).
    syncRef._emit({
      peerStates: [
        { docId: "test-doc", peer: { peerId: "peer-1" }, state: "pending" },
      ],
    })
    expect(store.getSnapshot()).toBe(true)
  })

  it("predicate select matches latched identities", () => {
    const syncRef = createMockSyncRef()
    const store = createDerivedSyncStore(syncRef, ref =>
      ref.readyFor(p => p.type === "service"),
    )
    store.subscribe(() => {})
    expect(store.getSnapshot()).toBe(false)

    syncRef._emit({
      reconciled: [{ peerId: "server-1", type: "service" }],
    })
    expect(store.getSnapshot()).toBe(true)
  })
})

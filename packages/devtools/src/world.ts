// world — the imperative shell: backing stores per stream + the
// observe→classify→store wiring.
//
// Each primitive is matched to its real semantics:
//   append logs (events, diagnostics) → @kyneta/index Collection (unique keys)
//   LWW current-state (peers, documents, syncStates) → @kyneta/changefeed
//     ReactiveMap (overwrite-by-key; index Collections do NOT propagate a
//     value-update for an existing key from a manual Source)
//   cross-peer grouping (byDoc over events; syncByDoc over syncStates) →
//     @kyneta/index Index.by. syncStates (an LWW ReactiveMap) reaches the
//     index via Source.fromReactiveMap (jj:qwzkmzvy).
//
// GATHER (ObsEvents) → PLAN (`classify`) → EXECUTE (apply routings via a
// uniform per-stream WriteTarget table). The pure `classify` is
// backing-agnostic; this file maps each stream to its store. Context:
// jj:pusmrzuy.

import { createReactiveMap, type ReactiveMapHandle } from "@kyneta/changefeed"
import type { ObsEvent } from "@kyneta/exchange"
import {
  Collection,
  Index,
  type KeySpec,
  Source,
  type SourceHandle,
} from "@kyneta/index"
import { classify, type WorldStream } from "./classify.js"
import type {
  DiagnosticEntry,
  DocView,
  PeerView,
  SyncEntry,
  WorldMapChange,
  WorldModel,
} from "./model.js"

const DEFAULT_EVENT_CAP = 5000

/**
 * Wrap a `SourceHandle` so its collection never exceeds `cap` entries,
 * evicting oldest-inserted keys (FIFO). `@kyneta/index` has no
 * windowing/eviction, so retention lives in the source.
 */
function boundedHandle<V>(
  handle: SourceHandle<V>,
  cap: number,
): SourceHandle<V> {
  const order = new Set<string>() // Set preserves insertion order → FIFO
  return {
    set(key: string, value: V): void {
      handle.set(key, value)
      if (!order.has(key)) {
        order.add(key)
        while (order.size > cap) {
          const oldest = order.values().next().value as string
          order.delete(oldest)
          handle.delete(oldest)
        }
      }
    },
    delete(key: string): void {
      handle.delete(key)
      order.delete(key)
    },
  }
}

function docIdOf(event: ObsEvent): string | undefined {
  return (event as { docId?: unknown }).docId as string | undefined
}

/**
 * A per-stream write target — the shell's uniform apply surface, so `ingest`
 * is `targets[stream][op](...)` with no per-stream branching. Append streams
 * use the (bounded) `SourceHandle` directly; LWW streams fuse set+emit.
 */
interface WriteTarget {
  set(key: string, value: unknown): void
  delete(key: string): void
}

/**
 * LWW write target: overwrite-by-key on the `ReactiveMap`, then emit the
 * change. (Index `Collection`s do not propagate a value-update for an existing
 * key; the `ReactiveMap` does — set + emit is the LWW write.)
 */
function lwwTarget(
  handle: ReactiveMapHandle<string, unknown, WorldMapChange>,
): WriteTarget {
  return {
    set(key, value) {
      handle.set(key, value)
      handle.emit({ changes: [{ type: "set", key }] })
    },
    delete(key) {
      handle.delete(key)
      handle.emit({ changes: [{ type: "delete", key }] })
    },
  }
}

/**
 * `SyncEntry` value equality — so a re-emitted, unchanged sync entry does not
 * churn the `syncByDoc` grouping (`Source.fromReactiveMap` skips equal
 * updates). Only `state` actually mutates; key fields are compared for safety.
 */
function sameSyncEntry(a: SyncEntry, b: SyncEntry): boolean {
  return a.docId === b.docId && a.peer === b.peer && a.state === b.state
}

/** A world model plus the producer-side ingest + teardown. */
export interface WorldModelHandle extends WorldModel {
  /** Apply one `ObsEvent` (the manual / merged-stream entry point). */
  ingest(event: ObsEvent): void
  /** Tear down all sources, collections, and indexes. */
  dispose(): void
}

export interface CreateWorldModelOptions {
  /** Max retained events in the `events` collection (FIFO). Default 5000. */
  readonly eventCap?: number
  /** Max retained diagnostics (FIFO). Default = `eventCap`. */
  readonly diagnosticCap?: number
}

/**
 * Build an empty world model. Feed it via `ingest` (or wire an Exchange with
 * `attach`). The views are live `@kyneta/index` / `@kyneta/changefeed` values
 * — each a `[CHANGEFEED]`.
 */
export function createWorldModel(
  options?: CreateWorldModelOptions,
): WorldModelHandle {
  const cap = options?.eventCap ?? DEFAULT_EVENT_CAP
  const diagCap = options?.diagnosticCap ?? cap

  // --- append logs (index Collections, FIFO-bounded) ---
  const [eventsSrc, eventsHandleRaw] = Source.create<ObsEvent>()
  const [diagSrc, diagHandleRaw] = Source.create<DiagnosticEntry>()
  const eventsHandle = boundedHandle(eventsHandleRaw, cap)
  const diagHandle = boundedHandle(diagHandleRaw, diagCap)
  const events = Collection.from(eventsSrc)
  const diagnostics = Collection.from(diagSrc)

  // --- LWW current-state (changefeed ReactiveMaps) ---
  const [peers, peersHandle] = createReactiveMap<
    string,
    PeerView,
    WorldMapChange
  >()
  const [documents, documentsHandle] = createReactiveMap<
    string,
    DocView,
    WorldMapChange
  >()
  const [syncStates, syncHandle] = createReactiveMap<
    string,
    SyncEntry,
    WorldMapChange
  >()

  // --- derived index groupings on the shared `docId` ---
  // events grouped by docId — cross-peer doc activity.
  const byDocKey: KeySpec<ObsEvent> = {
    groupKeys: (_k, e) => {
      const d = docIdOf(e)
      return d === undefined ? [] : [d]
    },
  }
  const byDoc = Index.by(events, byDocKey)

  // sync-state grouped by docId. The LWW `syncStates` map is bridged into the
  // index via `Source.fromReactiveMap` — in-place `state` updates lower to
  // retract+insert; `sameSyncEntry` suppresses no-op re-emits. Selectors read
  // membership from this index and resolve current values from `syncStates`,
  // so the per-call subscription churn of `SecondaryIndex.get()` is avoided.
  // Context: jj:qwzkmzvy.
  const syncEntries = Collection.from(
    Source.fromReactiveMap(syncStates, { equals: sameSyncEntry }),
  )
  const syncByDocKey: KeySpec<SyncEntry> = { groupKeys: (_k, e) => [e.docId] }
  const syncByDoc = Index.by(syncEntries, syncByDocKey)

  // --- uniform per-stream write targets (one source of truth for backing) ---
  const targets: Record<WorldStream, WriteTarget> = {
    events: eventsHandle as SourceHandle<unknown>,
    diagnostics: diagHandle as SourceHandle<unknown>,
    peers: lwwTarget(
      peersHandle as ReactiveMapHandle<string, unknown, WorldMapChange>,
    ),
    documents: lwwTarget(
      documentsHandle as ReactiveMapHandle<string, unknown, WorldMapChange>,
    ),
    syncStates: lwwTarget(
      syncHandle as ReactiveMapHandle<string, unknown, WorldMapChange>,
    ),
  }

  function ingest(event: ObsEvent): void {
    for (const r of classify(event)) {
      const target = targets[r.stream]
      if (r.op === "set") target.set(r.key, r.value)
      else target.delete(r.key)
    }
  }

  function dispose(): void {
    syncByDoc.dispose()
    syncEntries.dispose() // also disposes its fromReactiveMap source (unsub from syncStates)
    byDoc.dispose()
    events.dispose() // also disposes eventsSrc
    diagnostics.dispose() // also disposes diagSrc
    // ReactiveMaps hold no subscriptions of their own to tear down.
  }

  return {
    events,
    diagnostics,
    peers,
    documents,
    syncStates,
    byDoc,
    syncByDoc,
    ingest,
    dispose,
  }
}

/** The slice of an Exchange devtools consumes (structural — avoids a hard
 *  dependency on the `Exchange` class). */
export interface ObservableExchange {
  observe(sink: (event: ObsEvent) => void): () => void
}

/**
 * Wire an Exchange's observation stream into a world model. Returns the
 * `observe` unsubscribe (detach). The caller owns the `model` (built via
 * `createWorldModel`) so it can query the views and `dispose()` it.
 */
export function attach(
  exchange: ObservableExchange,
  model: WorldModelHandle,
): () => void {
  return exchange.observe(event => model.ingest(event))
}

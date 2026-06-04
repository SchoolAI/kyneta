// select — pure projections over the live world-model views.
//
// Selector discipline: read group MEMBERSHIP from a `SecondaryIndex`'s
// `.current` (a `Map<groupKey, Set<entryKey>>`) and resolve VALUES from the
// base store. Never call `SecondaryIndex.get(key)` from a selector — it
// allocates a fresh ReactiveMap + a subscription retained until index dispose
// on every call (a leak under repeated rendering). `.get()` is for a renderer
// that genuinely holds one group's live subscription. Context: jj:qwzkmzvy.
//
// Ordering note: per-peer order is exact (the bus `seq` is monotonic per
// peer); there is no cross-peer clock, so a merged timeline is ordered
// (peerId, seq) — a stable per-peer interleave, never a claimed global total
// order. Context: jj:pusmrzuy.

import type { ObsEvent } from "@kyneta/exchange"
import type { DocView, SyncEntry, WorldModel } from "./model.js"

/**
 * The per-peer sync entries for a doc. Membership comes from the `syncByDoc`
 * grouping (incrementally maintained); current values from `syncStates`.
 */
export function syncFor(
  model: WorldModel,
  docId: string,
): readonly SyncEntry[] {
  const entryKeys = model.syncByDoc.current.get(docId)
  if (entryKeys === undefined) return []
  const out: SyncEntry[] = []
  for (const key of entryKeys) {
    const entry = model.syncStates.get(key)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

/** Order events per-peer (exact, by `seq`); peers ordered by id (stable). */
function byPeerSeq(a: ObsEvent, b: ObsEvent): number {
  if (a.peerId !== b.peerId) return a.peerId < b.peerId ? -1 : 1
  return a.seq - b.seq
}

/** A composed per-document view assembled from the live collections. */
export interface DocViewComposite {
  readonly docId: string
  readonly doc: DocView | undefined
  readonly sync: readonly SyncEntry[]
  readonly activity: readonly ObsEvent[]
}

/** Compose a doc's directory entry + per-peer sync status + cross-peer activity. */
export function docView(model: WorldModel, docId: string): DocViewComposite {
  return {
    docId,
    doc: model.documents.get(docId),
    sync: syncFor(model, docId),
    activity: docActivity(model, docId),
  }
}

/** All doc-scoped events for a doc, per-peer-ordered. */
export function docActivity(
  model: WorldModel,
  docId: string,
): readonly ObsEvent[] {
  const entryKeys = model.byDoc.current.get(docId)
  if (entryKeys === undefined) return []
  const out: ObsEvent[] = []
  for (const key of entryKeys) {
    const event = model.events.get(key)
    if (event !== undefined) out.push(event)
  }
  return out.sort(byPeerSeq)
}

/** The full event log, per-peer-ordered. */
export function timeline(model: WorldModel): readonly ObsEvent[] {
  return [...model.events.current.values()].sort(byPeerSeq)
}

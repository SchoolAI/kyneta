// use-sync-state — reactive per-peer sync state subscription.
//
// useSyncState(doc) returns the current PeerSyncState[] for a document
// obtained from exchange.get(), and re-renders when the sync state
// changes (e.g. when a peer connects, syncs, or disconnects).
//
// All logic lives in createSyncStore (Functional Core); this hook
// is a thin Imperative Shell wrapper. For a monotonic "has this doc
// reconciled?" gate, prefer useDocReady(doc).

import { type PeerSyncState, sync } from "@kyneta/exchange"
import { useMemo, useSyncExternalStore } from "react"
import { createSyncStore } from "./store.js"

// ---------------------------------------------------------------------------
// useSyncState
// ---------------------------------------------------------------------------

/**
 * Subscribe to a document's raw per-peer sync state.
 *
 * Returns the current `PeerSyncState[]` and re-renders when the sync
 * state changes. The document must have been created via
 * `exchange.get()` (i.e. it must have sync capabilities).
 *
 * This is the escape hatch for multi-peer / authority cases. For the
 * common "safe to read?" gate, use `useDocReady(doc)` — a flicker-free
 * monotonic latch.
 *
 * ```tsx
 * function SyncIndicator({ doc }: { doc: Ref<typeof MySchema> }) {
 *   const peerStates = useSyncState(doc)
 *   const synced = peerStates.some(s => s.state === "synced")
 *   return <span>{synced ? "✅ Synced" : "⏳ Syncing..."}</span>
 * }
 * ```
 *
 * @param doc - A document ref from `exchange.get()` (or `useDocument()`).
 * @returns The current PeerSyncState[] array.
 * @throws If `doc` was not created via `exchange.get()` (no sync capabilities).
 */
export function useSyncState(doc: object): PeerSyncState[] {
  const store = useMemo(() => createSyncStore(sync(doc)), [doc])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

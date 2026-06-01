// use-doc-ready — reactive monotonic readiness latch for a document.
//
// useDocReady(doc) returns a boolean that flips to `true` the first time
// the doc reconciles with a peer (receives data, or a terminal `vacant`
// reply) and never regresses — across the reconnect re-handshake flip or a
// reconciled peer departing. This is the common "safe to read?" gate.
//
// For the raw per-peer array (multi-peer / debugging), use useSyncState.

import { type PeerIdentityDetails, sync } from "@kyneta/exchange"
import { useMemo, useSyncExternalStore } from "react"
import { createDerivedSyncStore } from "./store.js"

// ---------------------------------------------------------------------------
// useDocReady
// ---------------------------------------------------------------------------

/**
 * Subscribe to a document's monotonic readiness latch.
 *
 * Returns `false` while connecting and flips to `true` on first
 * reconciliation (data **or** `vacant`), then stays `true`. Pass
 * `opts.peer` to require reconciliation with a peer matching a predicate
 * (the authority / quorum case). The boolean snapshot is flicker-free.
 *
 * ```tsx
 * function Menu({ userDoc }: { userDoc: Ref<typeof UserSchema> }) {
 *   const ready = useDocReady(userDoc)
 *   if (!ready) return <Spinner />
 *   return <MenuItems doc={userDoc} />
 * }
 * ```
 *
 * @param doc - A document ref from `exchange.get()` (or `useDocument()`).
 * @param opts.peer - Optional predicate; require a matching reconciled peer.
 * @returns `true` once reconciled (subject to `opts.peer`), else `false`.
 * @throws If `doc` was not created via `exchange.get()` (no sync capabilities).
 */
export function useDocReady(
  doc: object,
  opts?: { peer?: (peer: PeerIdentityDetails) => boolean },
): boolean {
  const pred = opts?.peer
  const store = useMemo(
    () =>
      createDerivedSyncStore(sync(doc), ref =>
        pred ? ref.readyFor(pred) : ref.ready,
      ),
    [doc, pred],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

// describe-sync-status — presentational summary of a doc's sync state.
//
// A pure projection over the public sync primitives (`peerStates`,
// `connectivity`, `ready`) into a single human-facing label. Deliberately
// NOT a stored core type — the readiness latch (`ready`) and the raw
// per-peer array (`peerStates`) are the primitives; this is a derived
// convenience. Framework-agnostic and unit-testable without jsdom; lives
// in @kyneta/exchange and is re-exported from @kyneta/react.

import type { Connectivity, PeerSyncState } from "./types.js"

export type SyncStatusSummary =
  | "connecting"
  | "pending"
  | "synced"
  | "vacant"
  | "offline"

/**
 * Summarize a doc's sync state for display.
 *
 * Precedence:
 * - `offline` — no transports configured (nothing to sync with).
 * - not yet reconciled — `connecting` (no established peer) or `pending`
 *   (a peer is established and mid-handshake).
 * - reconciled (`ready`) — `synced` if any peer currently holds the doc,
 *   else `vacant` if the only reconciliation was a terminal will-not-serve.
 *   (Falls back to `synced` when the reconciled peer has since departed and
 *   no live per-peer entry remains — the latch still holds.)
 */
export function describeSyncStatus(
  peerStates: PeerSyncState[],
  connectivity: Connectivity,
  ready: boolean,
): SyncStatusSummary {
  if (connectivity === "offline") return "offline"

  if (!ready) {
    return connectivity === "connecting" ? "connecting" : "pending"
  }

  if (peerStates.some(s => s.state === "synced")) return "synced"
  if (peerStates.some(s => s.state === "vacant")) return "vacant"
  return "synced"
}

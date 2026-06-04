// model — the world-model shape.
//
// The world model is a *record of live `@kyneta/index` views*, not a bespoke
// snapshot. Each field is a `Collection`/`SecondaryIndex` — itself a
// `ReactiveMap`/`[CHANGEFEED]` — so renderers subscribe granularly with the
// same `useValue` they use elsewhere. Correctness of the keyed/grouped views
// is inherited from `@kyneta/index`'s proven algebra; the only bespoke logic
// is the pure `classify` that routes each `ObsEvent` to these views.
// Context: jj:pusmrzuy.

import type { ReactiveMap } from "@kyneta/changefeed"
import type { ObsEvent } from "@kyneta/exchange"
import type { Collection, SecondaryIndex } from "@kyneta/index"

/**
 * Change type for the LWW directory/status maps. `@kyneta/index` `Collection`s
 * are membership-oriented — a manual `Source.set` on an *existing* key emits
 * no delta, so a value that mutates (e.g. sync status `pending → synced`)
 * never propagates. LWW current-state therefore uses `@kyneta/changefeed`'s
 * `ReactiveMap` (overwrite-by-key + emit), while append/grouping uses
 * `@kyneta/index`. Context: jj:pusmrzuy.
 */
export type WorldMapChange = {
  readonly type: "set" | "delete"
  readonly key: string
}

/** Current connection status of a peer (last lifecycle change seen). */
export interface PeerView {
  readonly peerId: string
  readonly status: string
}

/** A document's presence + last lifecycle change. (Mode is not in the event
 *  stream; it would be a future producer addition.) */
export interface DocView {
  readonly docId: string
  readonly lastChange: string
}

/** Authoritative per-peer-doc sync status, keyed `${docId}:${peer}`. */
export interface SyncEntry {
  readonly docId: string
  readonly peer: string
  readonly state: "pending" | "synced" | "vacant"
}

/** A surfaced diagnostic (silent-failure signal). */
export interface DiagnosticEntry {
  readonly peerId: string
  readonly seq: number
  readonly severity: "error" | "warning"
  readonly message: string
  readonly docId?: string
}

/**
 * The reactive world model — a bundle of live `@kyneta/index` views over the
 * `ObsEvent` stream. Base `Collection`s are fed by the classifier; the
 * `*ByDoc` `SecondaryIndex`es derive from them (cross-peer, keyed on the
 * genuinely-shared `docId`).
 */
export interface WorldModel {
  // --- append logs: `@kyneta/index` Collections (unique keys, no value-update) ---
  /** Full event log, keyed `${peerId}:${seq}` (bounded — see `createWorldModel`). */
  readonly events: Collection<ObsEvent>
  /** Diagnostics, keyed `${peerId}:${seq}`. */
  readonly diagnostics: Collection<DiagnosticEntry>

  // --- LWW current-state: `@kyneta/changefeed` ReactiveMaps (overwrite-by-key) ---
  /** Current peers, keyed by `peerId` (removed on `peer-departed`). */
  readonly peers: ReactiveMap<string, PeerView, WorldMapChange>
  /** Known documents, keyed by `docId` (removed on `doc-removed`). */
  readonly documents: ReactiveMap<string, DocView, WorldMapChange>
  /** Per-peer-doc sync status, keyed `${docId}:${peer}`. */
  readonly syncStates: ReactiveMap<string, SyncEntry, WorldMapChange>

  // --- derived: cross-peer grouping on the shared `docId` ---
  /** All doc-scoped activity grouped by `docId`, across all peers. */
  readonly byDoc: SecondaryIndex<ObsEvent>
  /**
   * Per-peer-doc sync entries grouped by `docId` (membership maintained over
   * `syncStates` via `Source.fromReactiveMap`). Read group membership here;
   * resolve current values from `syncStates`. See `syncFor`. Context: jj:qwzkmzvy.
   */
  readonly syncByDoc: SecondaryIndex<SyncEntry>
}

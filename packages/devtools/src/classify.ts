// classify — the one bespoke piece: pure routing of an ObsEvent to the
// base world-model streams. Total (unknown layers/kinds → []), no I/O, no
// index, no Exchange — directly unit-testable with ObsEvent literals.
//
// Everything downstream (integration, grouping, joins, reactivity) is reused
// `@kyneta/index` + `@kyneta/changefeed` machinery. Context: jj:pusmrzuy.

import type { ObsEvent } from "@kyneta/exchange"
import type { DiagnosticEntry, DocView, PeerView, SyncEntry } from "./model.js"

/** The base streams the classifier routes into. */
export type WorldStream =
  | "events"
  | "peers"
  | "documents"
  | "syncStates"
  | "diagnostics"

/** A single mutation to a base stream's `Source`. */
export type Routing =
  | {
      readonly stream: WorldStream
      readonly op: "set"
      readonly key: string
      readonly value: unknown
    }
  | {
      readonly stream: WorldStream
      readonly op: "delete"
      readonly key: string
    }

/** The docId an event concerns, if any. */
function docIdOf(event: ObsEvent): string | undefined {
  return (event as { docId?: unknown }).docId as string | undefined
}

/**
 * Route an `ObsEvent` to base-stream mutations. LWW-by-key is achieved by
 * `Source.set` overwrite; presence by `set`/`delete`. Pure and total.
 */
export function classify(event: ObsEvent): readonly Routing[] {
  const routings: Routing[] = [
    // Every event joins the full log (unique key per peer).
    {
      stream: "events",
      op: "set",
      key: `${event.peerId}:${event.seq}`,
      value: event,
    },
  ]

  if (event.layer === "directory") {
    if (event.kind === "peer") {
      if (event.change === "peer-departed") {
        routings.push({ stream: "peers", op: "delete", key: event.peer })
      } else {
        const view: PeerView = { peerId: event.peer, status: event.change }
        routings.push({
          stream: "peers",
          op: "set",
          key: event.peer,
          value: view,
        })
      }
    } else if (event.kind === "doc") {
      if (event.change === "doc-removed") {
        routings.push({ stream: "documents", op: "delete", key: event.docId })
      } else {
        const view: DocView = { docId: event.docId, lastChange: event.change }
        routings.push({
          stream: "documents",
          op: "set",
          key: event.docId,
          value: view,
        })
      }
    } else if (event.kind === "sync-state") {
      const entry: SyncEntry = {
        docId: event.docId,
        peer: event.peer,
        state: event.state,
      }
      routings.push({
        stream: "syncStates",
        op: "set",
        key: `${event.docId}:${event.peer}`,
        value: entry,
      })
    }
  } else if (event.layer === "diagnostic") {
    const entry: DiagnosticEntry = {
      peerId: event.peerId,
      seq: event.seq,
      severity: event.severity,
      message: event.message,
      docId: docIdOf(event),
    }
    routings.push({
      stream: "diagnostics",
      op: "set",
      key: `${event.peerId}:${event.seq}`,
      value: entry,
    })
  }
  // protocol / wire / engine: live only in `events`; their grouped views derive.
  return routings
}

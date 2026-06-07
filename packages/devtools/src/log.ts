// log — a diagnostics-loud head over the observation stream.
//
// Split per the package's FC/IS discipline: a PURE `formatObservation` (the
// one-line render, unit-testable, reusable by any renderer) and the
// `logObservations` SHELL (sink + diagnostic escalation). `console` defaults
// live here in the shell only — it is universal (browser/Deno/Node), unlike
// `process.stdout`; the data path (`stream.ts`) stays sink-only. Context:
// jj:qpqwrlsx.

import type { ObsEvent } from "@kyneta/exchange"
import type { ObservableExchange } from "./world.js"

// Hand-rolled ANSI — no `chalk` dependency (keeps the package minimal/portable,
// same reasoning as the codec's no-Zod call). Off by default.
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const RESET = "\x1b[0m"

/** Per-layer one-line summary — the structured cause, not just the message. */
function summarize(event: ObsEvent): string {
  switch (event.layer) {
    case "protocol": {
      const parts = [event.dir === "out" ? "→" : "←", event.msgType]
      if (event.docId !== undefined) parts.push(`doc=${event.docId}`)
      if (event.peer !== undefined) parts.push(`peer=${event.peer}`)
      return parts.join(" ")
    }
    case "doc": {
      const n = event.ops.length
      return `${event.replay ? "[replay]" : "[local]"} ${event.docId} ${n} op${n === 1 ? "" : "s"}`
    }
    case "directory":
      if (event.kind === "peer") return `peer ${event.change} ${event.peer}`
      if (event.kind === "doc") return `doc ${event.change} ${event.docId}`
      return `sync ${event.docId}:${event.peer} ${event.state}`
    case "engine":
      return `${event.program} ${event.summary}`
    case "diagnostic": {
      // The structured cause: severity + code + (compared) local/remote.
      const parts: string[] = [event.severity, event.code]
      if ("docId" in event && event.docId !== undefined) {
        parts.push(`doc=${event.docId}`)
      }
      parts.push(`peer=${event.peer}`)
      if ("local" in event && "remote" in event) {
        parts.push(`${event.local} ≠ ${event.remote}`)
      }
      parts.push(`(${event.message})`)
      return parts.join(" ")
    }
    case "wire":
      return `${event.dir} ${event.frameKind} ${event.size}b`
  }
  return "" // forward-compat: an unknown (e.g. future v:2) layer
}

/**
 * Render one `ObsEvent` as a correlated one-line string, keyed `peerId:seq` +
 * layer + a per-layer summary. Diagnostics render their structured cause
 * (`severity` + `code` + `local`/`remote`), not just the message. ANSI is
 * optional and off by default (portable). Pure.
 */
export function formatObservation(
  event: ObsEvent,
  opts?: { color?: boolean },
): string {
  const color = opts?.color ?? false
  const id = `${event.peerId}:${event.seq}`
  const head = color ? `${DIM}${id}${RESET}` : id
  const layer =
    color && event.layer === "diagnostic"
      ? `${event.severity === "error" ? RED : YELLOW}${event.layer}${RESET}`
      : event.layer
  return `${head} ${layer} ${summarize(event)}`
}

/** Options for the {@link logObservations} shell. */
export interface LogObservationsOptions {
  /** Where each rendered line goes. Default `console.log`. */
  readonly write?: (s: string) => void
  /** Override the default `error`-severity escalation (default `console.error`). */
  readonly onDiagnostic?: (event: ObsEvent) => void
  /** ANSI in the rendered lines. Default `false`. */
  readonly color?: boolean
}

/**
 * Tap `exchange.observe`, print each event via `formatObservation`, and
 * escalate `error`-severity `diagnostic` events (default `console.error`;
 * `warning`s print normally). Returns the detach. Shell-only — the format is
 * the pure FC above.
 */
export function logObservations(
  exchange: ObservableExchange,
  opts?: LogObservationsOptions,
): () => void {
  const write = opts?.write ?? ((s: string) => console.log(s))
  const color = opts?.color ?? false
  return exchange.observe(event => {
    write(formatObservation(event, { color }))
    if (event.layer === "diagnostic" && event.severity === "error") {
      if (opts?.onDiagnostic !== undefined) opts.onDiagnostic(event)
      else console.error(formatObservation(event, { color }))
    }
  })
}

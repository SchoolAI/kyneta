// stream — observation-stream codec + egress + exchange-free ingest.
//
// The observation plane's DATA PATH. `ObsEvent` is plain JSON (`v: 1`, a
// decoupled string-literal vocabulary), so `JSON.stringify`/`parse` round-trips
// it; `WorldModelHandle.ingest` folds a raw event with NO Exchange. Together: a
// recorded/piped NDJSON stream reconstructs the same model state a live `attach`
// would (the delivery-agnostic property). Context: jj:qpqwrlsx.
//
// Platform-neutral: sinks are plain `(line) => void`, sources are
// `Iterable`/`AsyncIterable<string>` — no Node `Writable`/`stdout`/`console`
// here. Local egress only; cross-machine / `Line`-native egress is deferred.

import type { ObsEvent } from "@kyneta/exchange"
import type { ObservableExchange, WorldModelHandle } from "./world.js"

/**
 * Serialize one `ObsEvent` to a single JSON line (no trailing newline).
 * Newlines inside string fields are escaped by `JSON.stringify`, so the result
 * is always one NDJSON record. `v` is preserved — a consumer branches on it.
 */
export function serializeObservation(event: ObsEvent): string {
  return JSON.stringify(event)
}

/**
 * Parse one NDJSON line back to an `ObsEvent`. Tolerant — returns `undefined`
 * on blank/malformed input rather than throwing, so a diagnostic tool never
 * crashes on a torn line.
 *
 * Guarded beyond a bare `try`/`catch`: a raw `JSON.parse` lets a valid-JSON
 * *scalar* (`null` / `42` / `"x"`) through, and `classify`/`ingest` would then
 * throw on `null.peerId` (a structurally-empty object would instead pollute the
 * log with a `"undefined:undefined"` key). So reject anything that is not an
 * object carrying the envelope identity the `${peerId}:${seq}` key + `classify`
 * depend on. Guard `peerId`/`seq` ONLY — never `v` or `layer`: `classify` is
 * total on unknown layers, so a future `v: 2` / new-layer event survives the
 * codec rather than being rejected (forward-compat over strictness — this is a
 * same-`v`, same-trust-domain deserializer, not a validation boundary).
 */
export function parseObservation(line: string): ObsEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const e = parsed as Partial<ObsEvent>
  if (typeof e.peerId !== "string" || typeof e.seq !== "number")
    return undefined
  return parsed as ObsEvent
}

/**
 * Egress: tap `exchange.observe` and write `serializeObservation(ev) + "\n"`
 * per event to a generic sink. Returns the `observe` unsubscribe (detach).
 * Passive — inherits `observe`'s zero-cost-when-unobserved + fire-and-forget;
 * no producer/core change. The bus is live (no replay), so subscribe before
 * the activity you want to capture.
 */
export function streamObservations(
  exchange: ObservableExchange,
  write: (line: string) => void,
): () => void {
  return exchange.observe(event => {
    write(`${serializeObservation(event)}\n`)
  })
}

/**
 * Ingest: fold an iterable of NDJSON lines into a `WorldModel` with NO Exchange
 * (reusing `model.ingest`). Malformed lines are skipped (total, never throws).
 */
export function ingestObservations(
  lines: Iterable<string>,
  model: WorldModelHandle,
): void {
  for (const line of lines) {
    const event = parseObservation(line)
    if (event !== undefined) model.ingest(event)
  }
}

/**
 * Ingest, async variant — for live sockets / stdin. The caller frames bytes
 * into lines (e.g. Node `readline`); this consumes one line per item. Same
 * tolerant fold as {@link ingestObservations}.
 */
export async function ingestObservationStream(
  lines: AsyncIterable<string>,
  model: WorldModelHandle,
): Promise<void> {
  for await (const line of lines) {
    const event = parseObservation(line)
    if (event !== undefined) model.ingest(event)
  }
}

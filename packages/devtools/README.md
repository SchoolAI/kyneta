# @kyneta/devtools

Observe a Kyneta exchange: fold its event stream into a live, queryable world model — or serialize that stream out as NDJSON and tail it from another terminal.

## Overview

Every `Exchange` can emit a correlated stream of `ObsEvent`s across all layers — engine, protocol, doc, directory, diagnostics, wire (see [`exchange.observe()`](../exchange)). `@kyneta/devtools` does two things with that stream:

- **Folds it into a world model** — peers, documents, per-peer sync status, diagnostics, and cross-peer activity grouped by `docId` — composed from `@kyneta/index` + `@kyneta/changefeed`, so every view is reactive. The only bespoke logic is one pure classifier.
- **Moves it out of the process** — `ObsEvent` is plain JSON, so the stream serializes to NDJSON and folds back into the *same* model with **no Exchange**. Tail it, pipe it, record it, `jq` it.

This splits observability into two planes. The **observation plane** (events, sync status, diagnostics — op *summaries*) is serializable and location-independent; it egresses. The **interpretation plane** (actual document *values*) needs the substrate + schema and stays in-process. The stream carries op summaries, never values or CRDT bytes.

Experimental — tracks `ObsEvent` v1.

## Install

```sh
pnpm add @kyneta/devtools
```

## Build a live world model

`attach` an exchange to a model and query it with pure selectors — each view is a `[CHANGEFEED]`, so a renderer subscribes granularly.

```ts
import {
  createWorldModel,
  attach,
  convergence,
  syncFor,
} from "@kyneta/devtools"

const model = createWorldModel()
const detach = attach(exchange, model)

model.peers.size               // live peer count
syncFor(model, "my-doc")       // per-peer sync state for a doc
convergence(model)             // { state: "syncing", pending: 2, stuckDocs: [], ... }

// later
detach()
model.dispose()
```

## Tail an exchange's stream in another terminal

`@kyneta/devtools` doesn't hardcode a sink — `streamObservations` hands each event to a `(line) => void` you provide (the line already ends in `\n`). Point it at a file and you have NDJSON on disk:

```ts
// in your app process
import { streamObservations } from "@kyneta/devtools"
import { createWriteStream } from "node:fs"

const out = createWriteStream("observations.ndjson", { flags: "a" })
const stop = streamObservations(exchange, line => out.write(line))
// later: stop()  — detach; egress is passive and zero-cost when no one's tapping
```

Now watch it live from a second terminal. It's just newline-delimited JSON, so the usual tools work:

```sh
# everything, as it happens
tail -f observations.ndjson

# only the silent-failure signals — the highest-value line
tail -f observations.ndjson | jq 'select(.layer == "diagnostic")'

# just the errors (schema-hash / replica-type / sync-mode mismatches)
tail -f observations.ndjson | jq -c 'select(.severity == "error")'

# one doc's per-peer sync-state transitions, formatted
tail -f observations.ndjson \
  | jq -r 'select(.kind == "sync-state" and .docId == "my-doc")
           | "\(.peer) → \(.state)"'
```

Each line carries the envelope (`v`, `seq`, `t`, `peerId`, `layer`) plus its layer body — so you can filter, count, and correlate with nothing but `jq`.

## Fold a recorded stream back — no Exchange required

A recorded or piped stream reconstructs the **same** `peers` / `documents` / `syncStates` a live `attach` would (the delivery-agnostic property). Pipe a capture into a tiny inspector:

```ts
// inspect.ts — run as:  node inspect.ts < observations.ndjson
import {
  createWorldModel,
  ingestObservationStream,
  convergence,
  stalledDocs,
} from "@kyneta/devtools"
import { createInterface } from "node:readline"

const model = createWorldModel()
const lines = createInterface({ input: process.stdin }) // an AsyncIterable<string>

await ingestObservationStream(lines, model) // folds each line; skips torn ones
console.log(convergence(model))
console.log("wedged:", stalledDocs(model, { now: Date.now(), quietMs: 30_000 }))
```

For an in-memory array of lines, use the synchronous `ingestObservations(lines, model)`. Both are total — a malformed or torn line is skipped, never thrown.

## Convergence: done, or stuck?

`convergence(model)` is a pure, clock-free rollup — the one-glance answer to "is this peer caught up?"

```ts
convergence(model)
// {
//   state: "converged" | "syncing" | "stuck",
//   pending: number,              // sync-state entries still "pending"
//   pendingDocs: string[],        // docs with ≥1 pending peer
//   stuckDocs: string[],          // pending docs carrying an error diagnostic
//   errors: number,               // diagnostics with severity "error"
//   diagnostics: number,
// }
```

`stuck` gates on **error** severity — a convergence-preventing mismatch (schema-hash / replica-type / sync-mode), attributed per-doc where the diagnostic carries a `docId`. Warnings (e.g. protocol minor-skew) never gate. A peer-scoped error (no `docId`) produces a global `stuck` with an empty `stuckDocs` — honest: the failure is peer-scoped, not doc-scoped.

Convergence is clock-free by design. Its time-aware sibling, `stalledDocs(model, { now, quietMs })`, returns the pending docs that have been quiet too long ("probably wedged") — you inject `now`, so it's testable with a fixed clock.

## A diagnostics-loud log

For a human-readable tail without leaving the process, `logObservations` prints each event and escalates `error`-severity diagnostics (to `console.error` by default):

```ts
import { logObservations, formatObservation } from "@kyneta/devtools"

const stop = logObservations(exchange)               // → console.log / console.error
const stop2 = logObservations(exchange, {            // or supply your own sinks
  write: line => myLogger.info(line),
  onDiagnostic: ev => pager.notify(ev),
  color: true,
})

formatObservation(event)  // the pure one-line render, reusable by any renderer
// "alice:42 diagnostic error schema-hash-mismatch doc=clash peer=bob h1 ≠ h2 (hash mismatch)"
```

`formatObservation` is pure (ANSI off by default); `logObservations` is the shell that wires it to a sink. The data-path codec (`streamObservations` and below) never touches `console` — it stays platform-neutral (browser, Deno, Node).

## API at a glance

### World model

| | |
|---|---|
| `createWorldModel(opts?)` | Build an empty model. `ingest(event)`, `dispose()`, and the views. |
| `attach(exchange, model)` | Subscribe `exchange.observe` → `model.ingest`; returns detach. |
| `classify(event)` | The pure routing core (`ObsEvent → Routing[]`), exported for reuse. |

`WorldModel` views: `events`, `diagnostics` (append logs); `peers`, `documents`, `syncStates` (LWW maps); `byDoc`, `syncByDoc` (cross-peer `docId` groupings).

### Selectors

| | |
|---|---|
| `docView` / `docActivity` / `syncFor` / `timeline` | Pure projections over the live views. |
| `convergence(model)` | Clock-free rollup: `converged` / `syncing` / `stuck` + per-doc attribution. |
| `stalledDocs(model, { now, quietMs })` | Clock-injected staleness hint (pending docs quiet too long). |

### Stream (egress / ingest)

| | |
|---|---|
| `streamObservations(exchange, write)` | Tap `observe`, write one NDJSON record per event to a `(line) => void` sink. Returns detach. |
| `ingestObservations(lines, model)` | Fold an `Iterable<string>` of NDJSON back into a model — no Exchange. |
| `ingestObservationStream(lines, model)` | The `AsyncIterable<string>` variant (sockets / stdin). |
| `serializeObservation(event)` / `parseObservation(line)` | The line codec. `parse` is tolerant — a torn line returns `undefined`. |

### Log

| | |
|---|---|
| `formatObservation(event, { color? })` | Pure one-line render; diagnostics show their structured cause. |
| `logObservations(exchange, opts?)` | Shell: print each event + escalate `error` diagnostics. Returns detach. |

## Under the hood

The world model is *composed from the framework's own primitives* rather than re-derived: append logs are `@kyneta/index` `Collection`s, cross-peer groupings are `Index.by(...)` over the shared `docId`, and LWW current-state (peers / documents / sync status) is `@kyneta/changefeed` `ReactiveMap`s — so it inherits the DBSP ℤ-set algebra and the changefeed protocol instead of reinventing them. The only bespoke piece is the pure, total `classify`. See [TECHNICAL.md](./TECHNICAL.md) for the two-plane rationale, the tolerant codec, retention, and the selector discipline.

## License

MIT

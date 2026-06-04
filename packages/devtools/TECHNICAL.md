# @kyneta/devtools — Technical Reference

> **Package**: `@kyneta/devtools`
> **Role**: A reactive **world model** folded from the Kyneta observation (`ObsEvent`) stream, composed from existing machinery — `@kyneta/index` (append logs + cross-peer grouping) and `@kyneta/changefeed` `ReactiveMap`s (LWW current-state). The only bespoke logic is one pure classifier.
> **Depends on**: `@kyneta/index`, `@kyneta/changefeed`, `@kyneta/exchange` (the `ObsEvent` type; `observe` at runtime only inside `attach`)
> **Depended on by**: DevTools renderers (in-app panel, multi-peer inspector — not yet built)
> **Canonical symbols**: `classify`, `Routing`, `WorldStream`, `createWorldModel`, `WorldModelHandle`, `CreateWorldModelOptions`, `attach`, `ObservableExchange`, `WorldModel`, `PeerView`, `DocView`, `SyncEntry`, `DiagnosticEntry`, `WorldMapChange`, `docView`, `docActivity`, `syncFor`, `timeline`, `DocViewComposite`
> **Key invariant(s)**:
> 1. The world model is folded **purely from the `ObsEvent` stream** — never by reaching into the live Exchange. This keeps it delivery-agnostic (the same fold consumes one peer's `observe()` and a merged multi-peer stream).
> 2. The only bespoke logic is `classify` (pure, total). Grouping, joins, integration, and reactivity are reused `@kyneta/index` + `@kyneta/changefeed`.
> 3. Cross-peer correlation is keyed on the genuinely-shared `docId`. Frame `seq` is **not** a cross-peer key (see below).

`@kyneta/devtools` turns the producer-side `exchange.observe(sink)` stream (from `@kyneta/exchange`, jj:qpmkoryn) into a queryable, reactive model a renderer can bind to. Experimental — tracks `ObsEvent` v1.

---

## Architecture

**Thesis**: observation is *another interpreter of the event stream*, and the world model is *composed from the framework's own data primitives* — so it inherits their rigor (DBSP ℤ-set algebra, the changefeed protocol) instead of re-deriving it.

```
exchange.observe()  ─→  classify(event)  ─→  per-stream backing stores  ─→  views
  (ObsEvent stream)       (pure routings)     index Collections (append)     [CHANGEFEED]
                                              changefeed ReactiveMaps (LWW)
```

| Concern | Primitive | Why |
|---------|-----------|-----|
| Event log, diagnostics | `@kyneta/index` `Collection` (`Source.create` + `Collection.from`) | append-only, unique keys (`${peerId}:${seq}`) |
| Cross-peer `byDoc` grouping | `@kyneta/index` `Index.by(events, keySpec)` | incremental grouping on the shared `docId` |
| Cross-peer `syncByDoc` grouping | `@kyneta/index` `Index.by(Source.fromReactiveMap(syncStates), …)` | per-doc sync status across peers — the LWW map bridged into the index (jj:qwzkmzvy) |
| Peers, documents, sync status | `@kyneta/changefeed` `createReactiveMap` | **LWW current-state** — a value that mutates per key |
| Reactivity | `[CHANGEFEED]` (every view is one) | renderers `useValue(model.peers)` — granular, no monolithic model feed |

### The pure classifier (the only bespoke logic)

`classify(event: ObsEvent): readonly Routing[]` (`src/classify.ts`) maps one event to backing-agnostic mutations — `{ stream, op: "set" | "delete", key, value? }`. Total: an unknown layer/kind routes only to `events` and never throws. It does not know how a stream is backed (Collection vs ReactiveMap) — the shell (`src/world.ts`) decides that. This is the unit-tested functional core; everything else is reused machinery or thin wiring.

### Why LWW state is NOT an index `Collection` (and how it still feeds the index)

`@kyneta/index` `Collection`s are *membership-oriented*: a manual `Source.set(key, value)` emits an `added` delta **only for a new key** — re-setting an existing key to a new value emits nothing, so the value never updates downstream (and index has no aggregation operator). Sync status mutates (`pending → synced`), so `peers`/`documents`/`syncStates` are `@kyneta/changefeed` `ReactiveMap`s (overwrite-by-key + `emit`) — the same primitive `exchange.peers` uses. `events`/`diagnostics` have unique keys, so index `Collection`s fit them. Context: jj:pusmrzuy.

To **group** an LWW map, the map is bridged into the index via `Source.fromReactiveMap`: an in-place value update lowers to retract+insert at the source boundary (the DBSP/Materialize UPSERT envelope), so `syncByDoc = Index.by(Source.fromReactiveMap(syncStates, { equals }))` is an incrementally-maintained grouping rather than a linear scan. `equals` (a shallow `SyncEntry` compare) suppresses no-op re-emits. The base `syncStates` `ReactiveMap` is unchanged — a renderer still reads current status from it directly. Context: jj:qwzkmzvy.

### Cross-peer correlation: `docId`, not frame `seq`

`docId` is shared by every peer → `byDoc` (grouping doc-scoped events across peers) is correct under any topology. Frame `seq` is **not** a cross-peer key: it is per-(channel, direction), so counters collide across channels and across the two directions of one channel; `channelId` is peer-local (minted per synchronizer), not shared. Raw frame send↔receive pairing (`Index.join` on `seq`) is therefore omitted — a spurious thread is worse than none. A correct frame-level join awaits a content-addressed `Frame.hash` (reserved in the wire format), a separate wire-layer feature.

### Retention

`@kyneta/index` has no windowing ("not a window"). Both append logs self-bound via `boundedHandle(handle, cap)` — FIFO eviction of the oldest-inserted key past `cap`: `events` (`eventCap`, default 5000) and `diagnostics` (`diagnosticCap`, default = `eventCap`).

### Ordering

`timeline` / `docActivity` order by `(peerId, seq)`. Per-peer order is **exact** (the bus `seq` is monotonic per peer); there is no cross-peer clock, so the merged interleave is stable-per-peer — never claimed as a global total order.

### Selector discipline (snapshot reads)

`select.ts` selectors read group **membership** from a `SecondaryIndex`'s `.current` (`Map<groupKey, Set<entryKey>>`) and resolve **values** from the base store (`events` / `syncStates`). They never call `SecondaryIndex.get(key)`: that allocates a fresh `ReactiveMap` + a parent subscription retained until index `dispose()` on *every* call — a leak under repeated rendering. `.get()` is reserved for a renderer that genuinely holds one group's live subscription. Context: jj:qwzkmzvy.

---

## Public API

| Symbol | Role |
|--------|------|
| `createWorldModel(opts?) → WorldModelHandle` | Build an empty model. `ingest(event)` (manual / merged-stream entry), `dispose()`, and the views. |
| `attach(exchange, model) → () => void` | Subscribe `exchange.observe` → `model.ingest`; returns detach. Caller owns the model. |
| `classify(event) → Routing[]` | The pure routing core (exported for testing/reuse). |
| `docView` / `docActivity` / `syncFor` / `timeline` | Pure selectors over the live views. |

`WorldModel` fields: `events`, `diagnostics` (index `Collection`s); `peers`, `documents`, `syncStates` (`ReactiveMap`s); `byDoc`, `syncByDoc` (`SecondaryIndex`es).

## File Map

| File | Role |
|------|------|
| `src/classify.ts` | The pure classifier — `ObsEvent → Routing[]`. The only bespoke logic. |
| `src/model.ts` | `WorldModel` shape + view value types (`PeerView`/`DocView`/`SyncEntry`/`DiagnosticEntry`). |
| `src/world.ts` | Shell: per-stream backing (index `Collection`s + changefeed `ReactiveMap`s), `byDoc` + `syncByDoc` groupings, the uniform `WriteTarget` table (`lwwTarget`), `createWorldModel`, `attach`, `boundedHandle`. |
| `src/select.ts` | Pure selectors (`docView`, `docActivity`, `syncFor`, `timeline`) — membership from index `.current`, values from the base store. |
| `src/index.ts` | Public barrel. |

## Testing

`classify.test.ts` is pure (ObsEvent literals → routings; totality). `world.test.ts` / `views.test.ts` run a two-peer `Bridge` (`@kyneta/bridge-transport`), merge both peers' `observe()` streams into one model, and assert convergence + the cross-peer `byDoc` / `syncByDoc` groupings + `events`/`diagnostics` retention + selector-call stability. **Tests**: 11 passed. Run with `cd packages/devtools && pnpm verify`.

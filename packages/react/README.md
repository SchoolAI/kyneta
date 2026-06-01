# @kyneta/react

Thin React bindings for [`@kyneta/schema`](../schema) and [`@kyneta/exchange`](../exchange). Subscribe to collaborative documents with hooks, get plain JS snapshots with stable referential equality.

## Install

```sh
pnpm add @kyneta/react @kyneta/schema @kyneta/exchange react
```

## Quick Start

```tsx
import {
  ExchangeProvider,
  useDocument,
  useValue,
  change,
  Schema,
} from "@kyneta/react"
import { loro } from "@kyneta/loro-schema"

// 1. Define your schema and bind to a substrate
const TodoSchema = Schema.struct({
  title: Schema.text(),
  items: Schema.list(
    Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
  ),
})
const TodoDoc = loro.bind(TodoSchema)

// 2. Wrap your app in ExchangeProvider
function Root() {
  return (
    <ExchangeProvider config={{ adapters: [/* your adapter */] }}>
      <App />
    </ExchangeProvider>
  )
}

// 3. Use hooks to read and mutate
function App() {
  const doc = useDocument("my-doc", TodoDoc)
  const value = useValue(doc)
  // value: { title: string, items: { text: string, done: boolean }[] }

  return (
    <div>
      <h1>{value.title}</h1>
      <ul>
        {value.items.map((item, i) => (
          <li key={i}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => doc.items.at(i)?.done.set(!item.done)}
            />
            {item.text}
          </li>
        ))}
      </ul>
      <button onClick={() => doc.items.push({ text: "New todo", done: false })}>
        Add
      </button>
    </div>
  )
}
```

## API

### `<ExchangeProvider config={...}>`

Provides an `Exchange` instance to the React subtree. Creates the exchange from `config` on mount, calls `exchange.reset()` on unmount.

```tsx
<ExchangeProvider config={{ adapters: [wsAdapter] }}>
  <App />
</ExchangeProvider>
```

### `useExchange()`

Retrieves the `Exchange` from the nearest `ExchangeProvider`. Throws if called outside a provider.

### `useDocument(docId, boundSchema)`

Gets (or creates) a document from the Exchange. Returns a full-stack `Ref<S>` — callable, navigable, writable, transactable, and observable. Multiple calls with the same `docId` and `boundSchema` return the same ref instance.

```tsx
const doc = useDocument("my-doc", TodoDoc)
```

### `useValue(ref)`

Subscribes to a ref's current plain value. Returns `Plain<S>` — a plain JS snapshot — and re-renders when the changefeed fires. The snapshot is memoized for referential equality.

```tsx
// Full document — re-renders on any descendant change
const value = useValue(doc)

// Leaf field — re-renders only when this field changes
const title = useValue(doc.title)

// Nullish passthrough
const maybeValue = useValue(optionalRef) // null/undefined pass through
```

**Subscription granularity:**
- Composite refs (products, sequences, maps) subscribe deep via `subscribeTree` — any descendant change triggers a re-render.
- Leaf refs (scalars, text, counters) subscribe at node level — only own-path changes trigger a re-render.

### `useDocReady(doc, opts?)`

The 90% gate. Returns a **monotonic** `boolean` that flips to `true` the first time the doc reconciles with a peer (receives data, **or** a terminal `vacant` reply) and never regresses — across the reconnect re-handshake flip or a reconciled peer departing. Flicker-free (a stable scalar). Pass `opts.peer` to require reconciliation with a peer matching a predicate (authority / quorum).

```tsx
const ready = useDocReady(doc)
if (!ready) return <Spinner />
// require a service peer specifically:
const authReady = useDocReady(doc, { peer: (p) => p.type === "service" })
```

### `useSyncState(doc)`

The raw escape hatch (renamed from `useSyncStatus` in 2.0 — **breaking**). Returns `PeerSyncState[]` (`{ docId, peer, state: "pending" | "synced" | "vacant" }`) and re-renders on any per-peer change. Volatile — an entry can regress `synced → pending` on reconnect; for a stable gate use `useDocReady`.

```tsx
const peerStates = useSyncState(doc)
const synced = peerStates.some((s) => s.state === "synced")
```

### `sync(doc).settled(opts?)`

Promise that resolves (never rejects): `{ via: "local" }` immediately when no transports are configured, `{ via: "peer" }` on first reconciliation, or `{ via: "offline" }` after `opts.offlineAfter` ms with no upstream. `describeSyncStatus(peerStates, connectivity, ready)` projects the primitives into a single display label (`"connecting" | "pending" | "synced" | "vacant" | "offline"`).

### Mutations

A single mutation can be written directly — `doc.title.set("New title")` auto-commits. Use `batch()` (re-exported from `@kyneta/schema`) to group **multiple** mutations into one atomic commit and one notification:

```tsx
batch(doc, (d) => {
  d.title.set("New title")
  d.items.push({ text: "New item", done: false })
})
```

### Re-exports

`@kyneta/react` re-exports a curated subset so most app code only needs one import:

From `@kyneta/schema`: `batch`, `applyChanges`, `subscribe`, `subscribeNode`, `Schema`, `CHANGEFEED`, and types `Ref`, `RRef`, `Plain`, `Changeset`, `Op`, `BoundSchema`.

From `@kyneta/exchange`: `Exchange`, `sync`, `hasSync`, `describeSyncStatus`, and types `ExchangeParams`, `SyncRef`, `PeerSyncState`, `Connectivity`, `SyncStatusSummary`, `PeerIdentityDetails`, `DocId`.

## Architecture

The package follows a **Functional Core / Imperative Shell** pattern:

- **Functional Core** (`src/store.ts`): Pure `createChangefeedStore(ref)` and `createSyncStore(syncRef)` functions translate from kyneta's reactive protocols into the `{ subscribe, getSnapshot }` contract. Zero React imports. Independently testable.
- **Imperative Shell** (hooks): `useValue`, `useSyncState`, `useDocReady`, etc. are thin wrappers that feed the pure stores into React's `useSyncExternalStore`.

See [TECHNICAL.md](./TECHNICAL.md) for details on snapshot memoization, type recovery, and subscription strategy.

## Compared to `@loro-extended/react`

| Concern | loro-extended/react | @kyneta/react |
|---|---|---|
| Ref identity | Unstable — `.toJSON()` on every change | Stable — `doc.title === doc.title` |
| Subscription bridge | `createSyncStore` + version-key caching | Direct `CHANGEFEED` → `useSyncExternalStore` |
| `useValue` overloads | 12+ TypeScript overloads | Single conditional return type |
| Framework abstraction | `FrameworkHooks` DI + factory pattern | None — CHANGEFEED is the framework boundary |
| Text input hooks | `useCollaborativeText` (beforeinput) | Deferred (future work) |
| Undo/redo | `useUndoManager` | Deferred (future work) |

## License

MIT
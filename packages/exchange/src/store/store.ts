// store — persistence contract for the Exchange.
//
// The Store interface defines document-level operations that concrete
// backends implement. Backends need no knowledge of the wire protocol,
// substrates, sync protocols, or schemas.
//
// The contract is a unified record stream: both metadata and payload
// entries are `StoreRecord` values in a single ordered sequence per doc.
// Implementations maintain a materialized metadata index so that
// `currentMeta()` and `listDocIds()` are sublinear lookups.
//
// The Exchange guarantees that for any given docId, these methods are
// called sequentially — never concurrently. Backends may assume
// single-writer-per-document semantics.

import {
  type DocMetadata,
  replicaTypesCompatible,
  type SubstratePayload,
} from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"

// ---------------------------------------------------------------------------
// StoreMeta — per-document metadata (storage type)
// ---------------------------------------------------------------------------

/**
 * Per-document metadata persisted in the store.
 *
 * Structurally `Omit<DocMetadata, 'supportedHashes'>`. The `Omit`
 * relationship keeps `StoreMeta` in sync with `DocMetadata` if fields
 * are added — the compiler catches drift.
 *
 * `supportedHashes` is excluded because it is derived from the runtime
 * `BoundSchema.supportedHashes` set, not from the document's persisted
 * data. A cold-start inventory reconstructs supported hashes from
 * registered schemas, not from storage.
 */
export type StoreMeta = Omit<DocMetadata, "supportedHashes">

// ---------------------------------------------------------------------------
// StoreRecord — the unit of persistence
// ---------------------------------------------------------------------------

/**
 * A record in the unified store stream — either metadata or a payload entry.
 *
 * The stream is append-only per document. A document's first record
 * must be `meta`; appending an `entry` without a prior `meta` is an
 * error. `meta` records may be appended at any time (e.g. T0 schema
 * migration updates `schemaHash`).
 *
 * `meta` records carry identity (`replicaType`, `syncMode`) and
 * mutable state (`schemaHash`). `entry` records carry the opaque
 * `SubstratePayload` and the serialized version string.
 */
export type StoreRecord =
  | { readonly kind: "meta"; readonly meta: StoreMeta }
  | {
      readonly kind: "entry"
      readonly payload: SubstratePayload
      readonly version: string
    }

// ---------------------------------------------------------------------------
// Two kinds of metadata: per-document vs per-store
// ---------------------------------------------------------------------------
//
// `StoreMeta` above is *per-document* metadata — a map keyed by `docId`,
// reached through `append`/`currentMeta`/`listDocIds`. Backends persist it in
// a "doc_meta" namespace (a `kyneta_doc_meta` table, a `doc-meta\x00` key
// prefix, a `doc_meta` object store).
//
// Separately, a backend holds *store-global* metadata — facts about the store
// as a whole, with no `docId`. The first such fact is the on-disk format
// version (see `./store-format.ts`). It lives in a distinct "store_meta"
// namespace, physically separate from the per-doc map, and is read by a
// bootstrap reader on open — *before* the per-doc contract is trusted. It is
// not a document and never transits this interface. Keeping the two kinds in
// separate, self-describing namespaces (doc_meta vs store_meta) is why a
// store-global fact is never addressed by a `docId`. Context: jj:uvssotsy.

// ---------------------------------------------------------------------------
// Store — the persistence interface
// ---------------------------------------------------------------------------

/**
 * The persistence contract for a storage backend.
 *
 * Concrete backends implement these methods. They need no knowledge
 * of the sync protocol, substrates, or schemas — they store and
 * retrieve `StoreRecord` values faithfully.
 *
 * The Exchange guarantees single-writer-per-document semantics.
 *
 * `replace` must be atomic: a concurrent reader must never observe
 * an empty intermediate state — it sees either the pre-replace or
 * post-replace records.
 *
 * A `Store` instance is owned by exactly one `Exchange` for its
 * entire lifetime. Do not share stores across exchanges.
 */
export interface Store {
  /**
   * Append a record to a document's stream.
   *
   * If `record.kind === 'entry'` and no prior `meta` record exists
   * for this document, the implementation must throw.
   *
   * If `record.kind === 'meta'`, the implementation validates
   * immutable fields (`replicaType`, `syncMode`) against any
   * existing metadata via `resolveMetaFromBatch` and updates the
   * materialized metadata index.
   */
  append(docId: DocId, record: StoreRecord): Promise<void>

  /**
   * Load all records for a document, yielding in insertion order.
   * Returns an AsyncIterable to support pagination for large stores
   * without loading everything into memory.
   *
   * For a nonexistent document, yields nothing (no error).
   */
  loadAll(docId: DocId): AsyncIterable<StoreRecord>

  /**
   * Atomically replace all records for a document with a batch.
   * Used for compaction (meta + collapsed entirety).
   *
   * The batch must contain at least one `meta` record. Immutable
   * fields are validated against existing metadata. The materialized
   * index is updated from the resolved metadata.
   *
   * A concurrent reader must never observe an empty intermediate
   * state — it sees either pre-replace or post-replace records.
   */
  replace(docId: DocId, records: StoreRecord[]): Promise<void>

  /**
   * Delete all records and metadata for a document.
   * After this call, `currentMeta(docId)` returns `null` and
   * `loadAll(docId)` yields nothing.
   */
  delete(docId: DocId): Promise<void>

  /**
   * Return the current metadata for a document, or `null` if the
   * document has no records. This reads from the materialized
   * metadata index — not a full-stream scan.
   */
  currentMeta(docId: DocId): Promise<StoreMeta | null>

  /**
   * List all document IDs that have metadata in the store.
   * Returns an AsyncIterable to support million-doc stores without
   * loading all IDs into memory.
   *
   * If `prefix` is provided, only yields doc IDs starting with
   * that prefix.
   */
  listDocIds(prefix?: string): AsyncIterable<DocId>

  /**
   * Release resources held by this backend (file handles, connections).
   * Called by `Exchange.shutdown()`.
   */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// resolveMetaFromBatch — shared validation for Store implementations
// ---------------------------------------------------------------------------

/**
 * Compare two `SyncMode` values for deep equality.
 *
 * All three axes (`writerModel`, `delivery`, `durability`) must match.
 */
function syncModesEqual(
  a: StoreMeta["syncMode"],
  b: StoreMeta["syncMode"],
): boolean {
  return (
    a.writerModel === b.writerModel &&
    a.delivery === b.delivery &&
    a.durability === b.durability
  )
}

/**
 * Resolve the `StoreMeta` from a batch of `StoreRecord` values.
 *
 * Extracts all `meta` records from the batch, validates invariants,
 * and returns the resolved `StoreMeta`. Validation is implicit in
 * resolution — if the batch has no meta, resolution fails; if
 * immutable fields conflict with existing metadata, resolution fails.
 *
 * Invariants:
 * - The batch must contain at least one `meta` record.
 * - `replicaType` must be compatible with existing metadata
 *   (via `replicaTypesCompatible` — name + major version).
 * - `syncMode` must exactly match existing metadata
 *   (all three axes: writerModel, delivery, durability).
 * - `schemaHash` is last-writer-wins (the last `meta` record in
 *   the batch determines it).
 *
 * @param records - The batch of records to resolve from.
 * @param existingMeta - The current metadata for the document, or
 *   `null` if this is the first write.
 * @returns The resolved `StoreMeta`.
 * @throws If no `meta` record is present, or if immutable fields
 *   conflict with `existingMeta`.
 */
export function resolveMetaFromBatch(
  records: StoreRecord[],
  existingMeta: StoreMeta | null,
): StoreMeta {
  let resolved: StoreMeta | null = null

  for (const record of records) {
    if (record.kind !== "meta") continue

    const incoming = record.meta

    if (existingMeta !== null) {
      if (
        !replicaTypesCompatible(incoming.replicaType, existingMeta.replicaType)
      ) {
        throw new Error(
          `Store: replicaType mismatch for document — ` +
            `existing [${existingMeta.replicaType}] vs incoming [${incoming.replicaType}]`,
        )
      }
      if (!syncModesEqual(incoming.syncMode, existingMeta.syncMode)) {
        throw new Error(
          `Store: syncMode mismatch for document — ` +
            `existing ${JSON.stringify(existingMeta.syncMode)} vs ` +
            `incoming ${JSON.stringify(incoming.syncMode)}`,
        )
      }
    }

    if (resolved !== null) {
      if (!replicaTypesCompatible(incoming.replicaType, resolved.replicaType)) {
        throw new Error(
          `Store: replicaType mismatch within batch — ` +
            `[${resolved.replicaType}] vs [${incoming.replicaType}]`,
        )
      }
      if (!syncModesEqual(incoming.syncMode, resolved.syncMode)) {
        throw new Error(
          `Store: syncMode mismatch within batch — ` +
            `${JSON.stringify(resolved.syncMode)} vs ` +
            `${JSON.stringify(incoming.syncMode)}`,
        )
      }
    }

    // schemaHash is last-writer-wins
    resolved = incoming
  }

  if (resolved === null) {
    throw new Error("Store: batch must contain at least one meta record")
  }

  return resolved
}

// ---------------------------------------------------------------------------
// validateAppend — shared meta-first invariant guard for Store implementations
// ---------------------------------------------------------------------------

/**
 * IndexedDB cannot use this — it needs `tx.abort()` before throwing.
 *
 * @throws If the record is an `entry` and no prior `meta` exists.
 */
export function validateAppend(
  docId: string,
  record: StoreRecord,
  existingMeta: StoreMeta | null,
): StoreMeta | null {
  if (record.kind === "entry") {
    if (existingMeta === null) {
      throw new Error(
        `Store: first record for doc '${docId}' must be meta, got entry`,
      )
    }
    return null
  }

  return resolveMetaFromBatch([record], existingMeta)
}

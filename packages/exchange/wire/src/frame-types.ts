// frame-types — universal frame abstraction for @kyneta/wire.
//
// A frame is the delivery unit for the wire protocol. Every message
// sent over a transport is wrapped in a frame. The frame carries:
// - A protocol version
// - An optional content hash (reserved for future SHA-256 support)
// - Content that is either complete or a fragment of a larger payload
//
// The frame is parameterized on payload type T:
// - Binary pipeline: Frame<Uint8Array>
// - Text pipeline:   Frame<string>
//
// Batching is orthogonal to framing. The frame layer does not
// distinguish single messages from batches — that's the codec's
// concern. The payload's own structure (CBOR array vs map, JSON
// array vs object) determines singular vs plural.

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

/**
 * A complete payload — the frame carries the entire message or batch.
 */
export type Complete<T> = {
  readonly kind: "complete"
  readonly payload: T
}

/**
 * A fragment — the frame carries one piece of a larger payload.
 *
 * Fragments are fully self-describing: each carries its index, the
 * total fragment count, and the total payload size. The fragments of
 * one message are grouped by the enclosing frame's `seq` (see `Frame`):
 * the receiver collects fragments sharing a `seq` and concatenates them
 * in index order to reconstruct the original payload.
 */
export type Fragment<T> = {
  readonly kind: "fragment"
  /** Zero-based index of this fragment. */
  readonly index: number
  /** Total number of fragments in this group. */
  readonly total: number
  /** Total size of the original payload (bytes for binary, characters for text). */
  readonly totalSize: number
  /** This fragment's chunk of the payload. */
  readonly payload: T
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/**
 * The universal frame type.
 *
 * Everything sent over a wire transport is a frame. A frame has a
 * protocol version, a per-channel-direction sequence number, an
 * optional hash, and content that is either a complete payload or a
 * fragment of one.
 *
 * `seq` is a monotonic per-direction message identifier (uint32, wraps).
 * It is stamped on every frame — complete or fragment — so each
 * exchanged message can be named at the protocol level for debugging
 * and tracing. All fragments of one message share a single `seq`,
 * which also serves as their reassembly group key.
 *
 * @typeParam T - The payload type: `Uint8Array` for binary, `string` for text.
 */
export type Frame<T> = {
  readonly version: number
  /** Per-direction monotonic message id (uint32, wraps). Groups fragments. */
  readonly seq: number
  /** Content hash (null today, hex-encoded SHA-256 digest in the future). */
  readonly hash: string | null
  readonly content: Complete<T> | Fragment<T>
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function complete<T>(
  version: number,
  seq: number,
  payload: T,
  hash: string | null = null,
): Frame<T> {
  return { version, seq, hash, content: { kind: "complete", payload } }
}

export function fragment<T>(
  version: number,
  seq: number,
  index: number,
  total: number,
  totalSize: number,
  payload: T,
  hash: string | null = null,
): Frame<T> {
  return {
    version,
    seq,
    hash,
    content: { kind: "fragment", index, total, totalSize, payload },
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isComplete<T>(
  frame: Frame<T>,
): frame is Frame<T> & { content: Complete<T> } {
  return frame.content.kind === "complete"
}

export function isFragment<T>(
  frame: Frame<T>,
): frame is Frame<T> & { content: Fragment<T> } {
  return frame.content.kind === "fragment"
}

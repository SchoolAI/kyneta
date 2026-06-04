// frame — binary frame encoding/decoding for @kyneta/wire.
//
// Every binary message is wrapped in a frame with a 10-byte header:
//
//   ┌──────────┬──────────┬─────────────────────┬─────────────────────┐
//   │ Version  │   Type   │   Payload Length    │        Seq          │
//   │ (1 byte) │ (1 byte) │  (4 bytes, BE u32)  │  (4 bytes, BE u32)  │
//   ├──────────┴──────────┴─────────────────────┴─────────────────────┤
//   │  [if fragment: index(2B) + total(2B) + totalSize(4B)]           │
//   ├─────────────────────────────────────────────────────────────────┤
//   │  Payload (codec-encoded bytes)                                  │
//   └─────────────────────────────────────────────────────────────────┘
//
// The frame type byte distinguishes complete frames from fragments.
// `seq` is the per-direction monotonic message id; for fragments it is
// the reassembly group key (so there is no per-fragment id in the meta).
// Batching is orthogonal — the payload is self-describing (CBOR array
// vs map). The frame layer never needs to know.

import {
  BinaryFrameType,
  type BinaryFrameTypeValue,
  FRAGMENT_META_SIZE,
  HEADER_SIZE,
  WIRE_VERSION,
} from "./constants.js"
import type { WireCodec } from "./fragment-generic.js"
import type { Frame } from "./frame-types.js"
import { complete, fragment as fragmentFrame } from "./frame-types.js"
import { decodeWireMessage, encodeWireMessage } from "./wire-message-helpers.js"

// ---------------------------------------------------------------------------
// Encoding — generic
// ---------------------------------------------------------------------------

/**
 * Encode a `Frame<Uint8Array>` into its binary wire representation.
 *
 * Handles both complete and fragment frames. The payload must already
 * be codec-encoded (raw bytes).
 */
export function encodeBinaryFrame(
  frame: Frame<Uint8Array>,
): Uint8Array<ArrayBuffer> {
  const { version, seq, content } = frame

  if (content.kind === "complete") {
    const payload = content.payload
    const frameBytes = new Uint8Array(HEADER_SIZE + payload.length)
    const view = new DataView(frameBytes.buffer)

    view.setUint8(0, version)
    view.setUint8(1, BinaryFrameType.COMPLETE)
    view.setUint32(2, payload.length, false)
    view.setUint32(6, seq, false)

    frameBytes.set(payload, HEADER_SIZE)
    return frameBytes
  }

  const { index, total, totalSize, payload } = content

  const totalLen = HEADER_SIZE + FRAGMENT_META_SIZE + payload.length
  const frameBytes = new Uint8Array(totalLen)
  const view = new DataView(frameBytes.buffer)

  view.setUint8(0, version)
  view.setUint8(1, BinaryFrameType.FRAGMENT)
  view.setUint32(2, payload.length, false)
  view.setUint32(6, seq, false)

  // Fragment metadata (group key `seq` lives in the header above)
  let offset = HEADER_SIZE
  view.setUint16(offset, index, false)
  offset += 2
  view.setUint16(offset, total, false)
  offset += 2
  view.setUint32(offset, totalSize, false)
  offset += 4

  frameBytes.set(payload, offset)

  return frameBytes
}

// ---------------------------------------------------------------------------
// Decoding — generic
// ---------------------------------------------------------------------------

/**
 * Decode a binary wire frame back to a `Frame<Uint8Array>`.
 *
 * The returned frame contains the raw codec-encoded payload. Use
 * `decodeWireMessage` to get a `WireMessage`, then `applyInboundAliasing`
 * to obtain `ChannelMsg`.
 *
 * @throws FrameDecodeError if the frame is malformed
 */
export function decodeBinaryFrame(
  data: Uint8Array,
): Frame<Uint8Array<ArrayBuffer>> {
  // Normalize Buffer subclasses (Bun/Node may provide these)
  const frame: Uint8Array<ArrayBuffer> =
    data.buffer instanceof ArrayBuffer && data.constructor === Uint8Array
      ? (data as Uint8Array<ArrayBuffer>)
      : new Uint8Array(data)

  if (frame.length < HEADER_SIZE) {
    throw new FrameDecodeError(
      "truncated_frame",
      `Frame too short: expected at least ${HEADER_SIZE} bytes, got ${frame.length}`,
    )
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)

  const version = view.getUint8(0)
  if (version !== WIRE_VERSION) {
    throw new FrameDecodeError(
      "unsupported_version",
      `Unsupported wire version: ${version} (expected ${WIRE_VERSION})`,
    )
  }

  const type = view.getUint8(1) as BinaryFrameTypeValue
  const payloadLength = view.getUint32(2, false)
  const seq = view.getUint32(6, false)

  if (type === BinaryFrameType.COMPLETE) {
    const expectedLength = HEADER_SIZE + payloadLength
    if (frame.length < expectedLength) {
      throw new FrameDecodeError(
        "truncated_frame",
        `Complete frame truncated: expected ${expectedLength} bytes, got ${frame.length}`,
      )
    }

    const payload = frame.slice(HEADER_SIZE, HEADER_SIZE + payloadLength)
    return complete(version, seq, payload, null)
  }

  if (type === BinaryFrameType.FRAGMENT) {
    const expectedLength = HEADER_SIZE + FRAGMENT_META_SIZE + payloadLength
    if (frame.length < expectedLength) {
      throw new FrameDecodeError(
        "truncated_frame",
        `Fragment frame truncated: expected ${expectedLength} bytes, got ${frame.length}`,
      )
    }

    let offset = HEADER_SIZE
    const index = view.getUint16(offset, false)
    offset += 2
    const total = view.getUint16(offset, false)
    offset += 2
    const totalSize = view.getUint32(offset, false)
    offset += 4

    const payload = frame.slice(offset, offset + payloadLength)
    return fragmentFrame(version, seq, index, total, totalSize, payload, null)
  }

  throw new FrameDecodeError(
    "invalid_type",
    `Unknown frame type: 0x${(type as number).toString(16).padStart(2, "0")}`,
  )
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type FrameDecodeErrorCode =
  | "truncated_frame"
  | "unsupported_version"
  | "invalid_type"
  | "decode_failed"
  | "doc-id-too-long"
  | "schema-hash-too-long"
  | "doc-id-form-conflict"
  | "schema-hash-form-conflict"

export class FrameDecodeError extends Error {
  override readonly name = "FrameDecodeError"

  constructor(
    public readonly code: FrameDecodeErrorCode,
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Uint8Array concatenation helper
// ---------------------------------------------------------------------------

function concatUint8Arrays(
  chunks: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  let totalLength = 0
  for (const chunk of chunks) {
    totalLength += chunk.length
  }
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

// ---------------------------------------------------------------------------
// Binary codec record
// ---------------------------------------------------------------------------

export const BINARY_CODEC: WireCodec<Uint8Array<ArrayBuffer>> = {
  wireVersion: WIRE_VERSION,
  maxPayload: 0xffffffff,
  sizeOf: (c: Uint8Array) => c.length,
  concatenate: concatUint8Arrays,
  slice: (b: Uint8Array<ArrayBuffer>, start: number, end: number) =>
    b.subarray(start, end),
  encodeFrame: encodeBinaryFrame,
  decodeFrame: decodeBinaryFrame,
  encodeWire: encodeWireMessage,
  decodeWire: decodeWireMessage,
}

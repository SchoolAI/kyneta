// text-frame — text frame encoding/decoding for @kyneta/wire.
//
// Text frames use a JSON array wire format with a 2-character prefix:
//
//   Position 0: version character ('0' = version 0, '1' = version 1, ...)
//   Position 1: type character:
//     'c' = complete
//     'f' = fragment
//
// Complete frame:   ["2c", seq, <payload>]
// Fragment frame:   ["2f", seq, index, total, totalSize, chunk]
//
// `seq` is the per-direction monotonic message id, stamped on every
// frame; for fragments it is also the reassembly group key (replacing
// the v1 per-fragment `frameId` element, which it supersedes in place).
// The payload is a JSON-safe object (single message) or array (batch).
// Fragments carry JSON substring chunks. The receiver concatenates
// chunks in index order and JSON.parse the result.

import type { WireCodec } from "./fragment-generic.js"
import type { Frame } from "./frame-types.js"
import { complete, fragment } from "./frame-types.js"
import {
  decodeTextWireMessage,
  encodeTextWireMessage,
} from "./wire-message-helpers.js"

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export const TEXT_WIRE_VERSION = 2

// ---------------------------------------------------------------------------
// Prefix encoding
// ---------------------------------------------------------------------------

export function buildPrefix(version: number, isFragment: boolean): string {
  if (!Number.isInteger(version) || version < 0 || version > 9) {
    throw new RangeError(
      `text wire version ${version} exceeds single-digit prefix encoding (max 9)`,
    )
  }
  const versionChar = String(version)
  return versionChar + (isFragment ? "f" : "c")
}

/**
 * Parsed prefix information.
 */
type PrefixInfo = {
  version: number
  isFragment: boolean
}

/** @throws TextFrameDecodeError if the prefix is malformed */
function parsePrefix(prefix: string): PrefixInfo {
  if (typeof prefix !== "string" || prefix.length !== 2) {
    throw new TextFrameDecodeError(
      "invalid_prefix",
      `Expected 2-character prefix string, got: ${JSON.stringify(prefix)}`,
    )
  }

  const versionChar = prefix.charAt(0)
  const typeChar = prefix.charAt(1)

  const version = Number.parseInt(versionChar, 10)
  if (Number.isNaN(version)) {
    throw new TextFrameDecodeError(
      "invalid_prefix",
      `Invalid version character: ${JSON.stringify(versionChar)}`,
    )
  }

  switch (typeChar) {
    case "c":
      return { version, isFragment: false }
    case "f":
      return { version, isFragment: true }
    default:
      throw new TextFrameDecodeError(
        "invalid_prefix",
        `Unknown type character: ${JSON.stringify(typeChar)}`,
      )
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Encode a `Frame<string>` into its text wire representation.
 *
 * `seq` follows the prefix in every frame. For complete frames, the
 * payload is then embedded as a native JSON value (not a string within
 * a string), so the payload string must be valid JSON. For fragment
 * frames, the payload is a raw substring chunk embedded as a JSON
 * string element.
 */
export function encodeTextFrame(frame: Frame<string>): string {
  const { version, seq, content } = frame

  if (content.kind === "complete") {
    const prefix = buildPrefix(version, false)
    return `[${JSON.stringify(prefix)},${seq},${content.payload}]`
  }

  // Fragment
  const { index, total, totalSize, payload } = content
  const prefix = buildPrefix(version, true)
  return JSON.stringify([prefix, seq, index, total, totalSize, payload])
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode a text wire frame back to a `Frame<string>`.
 *
 * For complete frames, the payload is re-serialized to a JSON string
 * so that `Frame<string>` always carries a string payload.
 *
 * For fragment frames, the payload is a JSON substring chunk (string).
 *
 * @throws TextFrameDecodeError if the frame is malformed
 */
export function decodeTextFrame(wire: string): Frame<string> {
  let arr: unknown[]
  try {
    const parsed = JSON.parse(wire)
    if (!Array.isArray(parsed) || parsed.length < 2) {
      throw new TextFrameDecodeError(
        "invalid_structure",
        "Text frame must be a JSON array with at least 2 elements",
      )
    }
    arr = parsed
  } catch (error) {
    if (error instanceof TextFrameDecodeError) throw error
    throw new TextFrameDecodeError(
      "invalid_json",
      `Failed to parse text frame JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const { version, isFragment } = parsePrefix(arr[0] as string)

  if (version !== TEXT_WIRE_VERSION) {
    throw new TextFrameDecodeError(
      "unsupported_version",
      `Unsupported text wire version: ${version} (expected ${TEXT_WIRE_VERSION})`,
    )
  }

  const seq = arr[1]
  if (typeof seq !== "number") {
    throw new TextFrameDecodeError(
      "invalid_structure",
      "Frame seq must be a number",
    )
  }

  if (!isFragment) {
    // Complete frame: ["Vc", seq, payload]
    if (arr.length < 3) {
      throw new TextFrameDecodeError(
        "truncated",
        `Complete frame requires at least 3 elements, got ${arr.length}`,
      )
    }
    const payload = JSON.stringify(arr[2])
    return complete(version, seq, payload, null)
  }

  // Fragment frame: ["Vf", seq, index, total, totalSize, chunk]
  if (arr.length < 6) {
    throw new TextFrameDecodeError(
      "truncated",
      `Fragment frame requires at least 6 elements, got ${arr.length}`,
    )
  }

  const index = arr[2] as number
  const total = arr[3] as number
  const totalSize = arr[4] as number
  const chunk = arr[5] as string

  if (
    typeof index !== "number" ||
    typeof total !== "number" ||
    typeof totalSize !== "number"
  ) {
    throw new TextFrameDecodeError(
      "invalid_structure",
      "Fragment index/total/totalSize must be numbers",
    )
  }
  if (typeof chunk !== "string") {
    throw new TextFrameDecodeError(
      "invalid_structure",
      "Fragment chunk must be a string",
    )
  }

  return fragment(version, seq, index, total, totalSize, chunk, null)
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Error codes for text frame decode failures.
 */
export type TextFrameDecodeErrorCode =
  | "invalid_json"
  | "invalid_prefix"
  | "invalid_structure"
  | "unsupported_version"
  | "truncated"
  | "doc-id-too-long"
  | "schema-hash-too-long"
  | "doc-id-form-conflict"
  | "schema-hash-form-conflict"

/**
 * Error thrown when text frame decoding fails.
 */
export class TextFrameDecodeError extends Error {
  override readonly name = "TextFrameDecodeError"

  constructor(
    public readonly code: TextFrameDecodeErrorCode,
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Text codec record
// ---------------------------------------------------------------------------

export const TEXT_CODEC: WireCodec<string> = {
  wireVersion: TEXT_WIRE_VERSION,
  maxPayload: 0x7fffffff,
  sizeOf: (s: string) => Array.from(s).length,
  concatenate: (chunks: readonly string[]) => chunks.join(""),
  slice: (s: string, start: number, end: number) =>
    Array.from(s).slice(start, end).join(""),
  encodeFrame: encodeTextFrame,
  decodeFrame: decodeTextFrame,
  encodeWire: encodeTextWireMessage,
  decodeWire: decodeTextWireMessage,
}

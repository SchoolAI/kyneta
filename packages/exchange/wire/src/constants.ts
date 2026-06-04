// constants — wire protocol constants for @kyneta/wire.
//
// Defines the binary protocol framing: version byte, type byte,
// header size, and fragment layout sizes.
//
// Version 3 — 10-byte header (version + type + u32 payload length +
// u32 per-direction sequence number), substrate-agnostic fragmentation.
// The `seq` stamps every frame so each exchanged message is referenceable
// at the protocol level; for fragments it also serves as the group key,
// replacing the v2 per-fragment `frameId` metadata field.

// ---------------------------------------------------------------------------
// Frame header
// ---------------------------------------------------------------------------

export const WIRE_VERSION = 3

/**
 * Frame header size in bytes:
 * version (1) + type (1) + payload length (4) + seq (4) = 10.
 *
 * `payloadLength` stays at offset 2 and `seq` is appended at offset 6,
 * so a stream framer that delimits frames by reading the type byte and
 * payload length needs no offset changes — only this size constant.
 */
export const HEADER_SIZE = 10

// ---------------------------------------------------------------------------
// Binary frame type (byte 1 of header)
// ---------------------------------------------------------------------------

/**
 * Frame type byte in the binary frame header.
 *
 * - `COMPLETE`: payload is a complete message (single or batch — self-describing)
 * - `FRAGMENT`: payload is one chunk of a fragmented message, with fragment metadata
 */
export const BinaryFrameType = {
  COMPLETE: 0x00,
  FRAGMENT: 0x01,
} as const

export type BinaryFrameTypeValue =
  (typeof BinaryFrameType)[keyof typeof BinaryFrameType]

// ---------------------------------------------------------------------------
// Fragment layout sizes
// ---------------------------------------------------------------------------

/**
 * Size of fragment metadata following the frame header:
 * index (u16: 2) + total (u16: 2) + totalSize (u32: 4) = 8 bytes.
 *
 * The group key (`seq`) lives in the frame header, not here — in v2 this
 * block also carried a `frameId (u16)`, now subsumed by the header `seq`.
 */
export const FRAGMENT_META_SIZE = 2 + 2 + 4

/**
 * Minimum size of a fragment frame (header + metadata + at least 1 byte):
 * 10 (header) + 8 (metadata) + 1 (data) = 19 bytes.
 */
export const FRAGMENT_MIN_SIZE = HEADER_SIZE + FRAGMENT_META_SIZE + 1

// ---------------------------------------------------------------------------
// Identifier length caps
// ---------------------------------------------------------------------------

/**
 * Maximum length of a `DocId` in UTF-8 bytes. Receivers MUST reject any
 * `doc` / `d` field with a UTF-8 byte length exceeding this value.
 *
 * Applied uniformly across binary and text codecs. The unit is bytes, not
 * codepoints — multi-byte UTF-8 characters count proportionally to their
 * encoded byte length.
 */
export const DOC_ID_MAX_UTF8_BYTES = 512

/**
 * Maximum length of a schema hash in UTF-8 bytes. Receivers MUST reject
 * any `sh` field with a UTF-8 byte length exceeding this value.
 *
 * Schema hashes are conventionally Blake3-prefix hex (~34 chars); the cap
 * leaves headroom for alternate hash families.
 */
export const SCHEMA_HASH_MAX_UTF8_BYTES = 256

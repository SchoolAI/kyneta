// hash — deterministic schema fingerprinting and FNV-1a hashing.
//
// Extracted from substrate.ts so that migration.ts can depend on
// hashing without importing the full substrate interface surface.
//
// Implementation routes through `@sindresorhus/fnv1a` (single-pass,
// bigint-native, true 128-bit FNV-1a over UTF-8 bytes). Predecessor
// was an in-house two-pass FNV-1a-64 with shared prime that
// overstated its effective entropy. See plan: jj:snrmsznm.

import fnv1a from "@sindresorhus/fnv1a"
import { KIND, type Schema as SchemaNode } from "./schema.js"

/**
 * Algorithm-version prefix on `computeSchemaHash` output. Bump on any
 * change to the hash bytes (algorithm, canonicalization, or byte
 * encoding). Wire- and storage-visible.
 *
 * - `"00"`: two-pass FNV-1a-64 with shared prime, UTF-16 code-unit input
 *   (retired; see plan jj:snrmsznm).
 * - `"01"`: single-pass FNV-1a-128 via `@sindresorhus/fnv1a`, UTF-8 bytes.
 */
export const HASH_ALGORITHM_VERSION = "01" as const

/**
 * Compute a deterministic fingerprint from a schema's structural shape.
 *
 * The result is a 34-character hex string:
 *   - 2-char algorithm-version prefix (`HASH_ALGORITHM_VERSION`)
 *   - 32-char hex hash (16 bytes)
 *
 * The canonical serialization captures field names (alphabetical order),
 * field types (scalar kind, annotation tag, structural kind), and nested
 * structure (recursive). It does NOT capture runtime values or
 * backend-specific details.
 *
 * This is a **versioning commitment** — the hash must never change for
 * the same schema across releases *at the same algorithm version*. The
 * version prefix is the explicit signal when bytes change.
 */
export function computeSchemaHash(schema: SchemaNode): string {
  return `${HASH_ALGORITHM_VERSION}${fnv1aHex(canonicalizeSchema(schema))}`
}

/**
 * 32-char hex of FNV-1a-128 over UTF-8 bytes. Algorithm-internal —
 * not version-tagged. Used by `computeSchemaHash` (which prepends
 * `HASH_ALGORITHM_VERSION`) and by `deriveIdentity` (which uses raw
 * 32 hex chars because identities are opaque positional addresses
 * consumed only by `SchemaBinding` internals).
 */
export function fnv1aHex(input: string): string {
  return fnv1a(input, { size: 128 }).toString(16).padStart(32, "0")
}

/**
 * Produce a deterministic string representation of a schema's structure.
 *
 * The format is a compact S-expression-like notation:
 *   - scalar: `s:kind` (e.g. `s:string`, `s:number`)
 *   - product: `p(field1:...,field2:...)` with fields in alphabetical order
 *   - sequence: `q(item)`
 *   - map: `m(value)`
 *   - sum: `u(v0,v1,...)` for positional, `d:disc(tag0:...,tag1:...)` for discriminated
 *   - text: `t:text`
 *   - counter: `t:counter`
 *   - set: `t:set(item)`
 *   - tree: `t:tree(nodeData)`
 *   - movable: `t:movable(item)`
 */
function canonicalizeSchema(schema: SchemaNode): string {
  switch (schema[KIND]) {
    case "scalar": {
      const constraint = (schema as any).constraint as unknown[] | undefined
      if (constraint && constraint.length > 0) {
        // Include constraints in the hash for discriminated sum tags
        return `s:${schema.scalarKind}[${constraint.map(String).join(",")}]`
      }
      return `s:${schema.scalarKind}`
    }

    case "product": {
      const fields = Object.entries(
        (schema as any).fields as Record<string, SchemaNode>,
      ).sort(([a], [b]) => a.localeCompare(b))
      const parts = fields.map(
        ([name, fieldSchema]) => `${name}:${canonicalizeSchema(fieldSchema)}`,
      )
      return `p(${parts.join(",")})`
    }

    case "sequence":
      return `q(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "map":
      return `m(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "sum": {
      const discriminant = (schema as any).discriminant as string | undefined
      if (discriminant !== undefined) {
        // Discriminated sum — variants are products, keyed by discriminant tag
        const variants = (schema as any).variants as SchemaNode[]
        const parts = variants
          .map((v: SchemaNode) => canonicalizeSchema(v))
          .sort()
        return `d:${discriminant}(${parts.join(",")})`
      }
      // Positional sum
      const variants = (schema as any).variants as SchemaNode[]
      const parts = variants.map((v: SchemaNode) => canonicalizeSchema(v))
      return `u(${parts.join(",")})`
    }

    case "text":
      return `t:text`

    case "counter":
      return `t:counter`

    case "set":
      return `t:set(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "tree":
      return `t:tree(${canonicalizeSchema((schema as any).nodeData as SchemaNode)})`

    case "movable":
      return `t:movable(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "richtext": {
      const marks = (schema as any).marks as Record<string, { expand: string }>
      const parts = Object.keys(marks)
        .sort()
        .map(k => `${k}:${marks[k]!.expand}`)
      return `t:richtext(${parts.join(",")})`
    }

    default:
      throw new Error(
        `canonicalizeSchema: unknown schema kind "${(schema as any)[KIND]}"`,
      )
  }
}

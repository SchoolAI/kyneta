// schema-hash — computeSchemaHash stability and differentiation tests.
//
// computeSchemaHash is a versioning commitment: the hash for a given
// schema must never change across releases. These tests protect against
// accidental changes to the canonical serialization or hash algorithm.

import {
  computeSchemaHash,
  HASH_ALGORITHM_VERSION,
  KIND,
  Schema,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
// canonicalTuple is internal — imported from source, NOT the public barrel.
import { canonicalTuple } from "../hash.js"

// ===========================================================================
// Helpers
// ===========================================================================

const SimpleDoc = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("computeSchemaHash", () => {
  // ── Format ──

  it("produces a 34-character hex string with HASH_ALGORITHM_VERSION prefix", () => {
    const hash = computeSchemaHash(SimpleDoc)
    expect(hash).toHaveLength(34)
    expect(hash.slice(0, 2)).toBe(HASH_ALGORITHM_VERSION)
    expect(hash.startsWith(HASH_ALGORITHM_VERSION)).toBe(true)
    expect(/^[0-9a-f]{32}$/.test(hash.slice(2))).toBe(true)
  })

  it("HASH_ALGORITHM_VERSION is the current published prefix", () => {
    // Locks the version against accidental change without a coordinated bump.
    expect(HASH_ALGORITHM_VERSION).toBe("02")
  })

  // ── Determinism ──

  it("same schema returns identical hash on repeated calls", () => {
    const h1 = computeSchemaHash(SimpleDoc)
    const h2 = computeSchemaHash(SimpleDoc)
    expect(h1).toBe(h2)
  })

  it("structurally equivalent schemas from independent construction produce same hash", () => {
    const a = Schema.struct({ title: Schema.string(), count: Schema.number() })
    const b = Schema.struct({ title: Schema.string(), count: Schema.number() })
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b))
  })

  // ── Alphabetical canonicalization ──

  it("field insertion order does not affect hash", () => {
    const forward = Schema.struct({
      alpha: Schema.string(),
      beta: Schema.number(),
      gamma: Schema.boolean(),
    })

    // Construct with reversed insertion order
    const fields: Record<string, any> = {}
    fields.gamma = Schema.boolean()
    fields.beta = Schema.number()
    fields.alpha = Schema.string()
    const reversed = Schema.struct(fields)

    expect(computeSchemaHash(forward)).toBe(computeSchemaHash(reversed))
  })

  // ── Differentiation ──

  it("different field names produce different hashes", () => {
    const a = Schema.struct({ title: Schema.string() })
    const b = Schema.struct({ name: Schema.string() })
    expect(computeSchemaHash(a)).not.toBe(computeSchemaHash(b))
  })

  it("different field types produce different hashes", () => {
    const a = Schema.struct({ value: Schema.string() })
    const b = Schema.struct({ value: Schema.number() })
    expect(computeSchemaHash(a)).not.toBe(computeSchemaHash(b))
  })

  it("additional field produces different hash", () => {
    const v1 = Schema.struct({ title: Schema.string() })
    const v2 = Schema.struct({ title: Schema.string(), count: Schema.number() })
    expect(computeSchemaHash(v1)).not.toBe(computeSchemaHash(v2))
  })

  it("nested structure difference produces different hash", () => {
    const flat = Schema.struct({ data: Schema.string() })
    const nested = Schema.struct({
      data: Schema.struct({ inner: Schema.string() }),
    })
    expect(computeSchemaHash(flat)).not.toBe(computeSchemaHash(nested))
  })

  it("first-class type difference produces different hash", () => {
    const plain = Schema.struct({ content: Schema.string() })
    const withText = Schema.struct({
      content: Schema.text(),
    })
    expect(computeSchemaHash(plain)).not.toBe(computeSchemaHash(withText))
  })

  it("list vs record of same item type produce different hashes", () => {
    const withList = Schema.struct({ items: Schema.list(Schema.string()) })
    const withRecord = Schema.struct({ items: Schema.record(Schema.string()) })
    expect(computeSchemaHash(withList)).not.toBe(computeSchemaHash(withRecord))
  })

  // ── Schema kinds coverage ──

  it("handles all structural kinds without throwing", () => {
    const complex = Schema.struct({
      text: Schema.text(),
      scalar: Schema.string(),
      nested: Schema.struct({
        inner: Schema.number(),
      }),
      list: Schema.list(Schema.boolean()),
      record: Schema.record(Schema.string()),
      optional: Schema.string().nullable(),
    })

    const hash = computeSchemaHash(complex)
    expect(hash).toHaveLength(34)
    expect(hash.startsWith(HASH_ALGORITHM_VERSION)).toBe(true)
  })
})

// ===========================================================================
// Injectivity (the class property) — distinct structure ⟹ distinct hash.
// These pin the collisions the "01" S-expression form allowed.
// ===========================================================================

describe("computeSchemaHash — injectivity", () => {
  // No public builder sets scalar constraints directly; construct the node
  // shape. KIND is the only runtime tag canonicalization reads.
  const constrained = (constraint: readonly unknown[]) =>
    ({ [KIND]: "scalar", scalarKind: "string", constraint }) as never

  it("a field name containing delimiters cannot forge structure", () => {
    // One field whose NAME embeds the old delimiters vs. two ordinary
    // fields — these collided under "01"; they must not under "02".
    const one = Schema.struct({ "a:s:string,b": Schema.number() })
    const two = Schema.struct({ a: Schema.string(), b: Schema.number() })
    expect(computeSchemaHash(one)).not.toBe(computeSchemaHash(two))
  })

  it("constraint list elements cannot forge structure", () => {
    expect(computeSchemaHash(constrained(["a,b"]))).not.toBe(
      computeSchemaHash(constrained(["a", "b"])),
    )
  })

  it('constraint value type is significant (number 1 vs string "1")', () => {
    expect(computeSchemaHash(constrained([1]))).not.toBe(
      computeSchemaHash(constrained(["1"])),
    )
  })

  it("structurally identical schemas (delimiter-laden names) still match", () => {
    const a = Schema.struct({ "x,y": Schema.string() })
    const b = Schema.struct({ "x,y": Schema.string() })
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b))
  })
})

// ===========================================================================
// JSON-boundary completeness — .json() distinct from non-.json().
// ===========================================================================

describe("computeSchemaHash — JSON boundary", () => {
  it("struct vs struct.json of identical fields differ", () => {
    const plain = Schema.struct({ a: Schema.string(), b: Schema.number() })
    const json = Schema.struct.json({ a: Schema.string(), b: Schema.number() })
    expect(computeSchemaHash(plain)).not.toBe(computeSchemaHash(json))
  })

  it("list vs list.json of identical item differ", () => {
    expect(computeSchemaHash(Schema.list(Schema.string()))).not.toBe(
      computeSchemaHash(Schema.list.json(Schema.string())),
    )
  })

  it("record vs record.json of identical item differ", () => {
    expect(computeSchemaHash(Schema.record(Schema.string()))).not.toBe(
      computeSchemaHash(Schema.record.json(Schema.string())),
    )
  })

  it("a nested boundary vs nested non-boundary differ", () => {
    const plain = Schema.struct({
      inner: Schema.struct({ a: Schema.string() }),
    })
    const json = Schema.struct({
      inner: Schema.struct.json({ a: Schema.string() }),
    })
    expect(computeSchemaHash(plain)).not.toBe(computeSchemaHash(json))
  })

  it(".nullable() stays distinct (structural sum, not a boundary)", () => {
    expect(computeSchemaHash(Schema.string())).not.toBe(
      computeSchemaHash(Schema.string().nullable()),
    )
  })
})

// ===========================================================================
// Finite/acyclic precondition — cycle guard + DAG sharing.
// ===========================================================================

describe("computeSchemaHash — finite/acyclic precondition", () => {
  it("a forced cyclic schema graph throws a clear depth-limit error", () => {
    // The grammar forbids this (fields are eager Schema); force it past the
    // types. It must fail loudly, not as an opaque RangeError.
    const a = Schema.struct({ label: Schema.string() }) as {
      fields: Record<string, unknown>
    }
    a.fields.self = a
    expect(() => computeSchemaHash(a as never)).toThrow(/nesting exceeds limit/)
  })

  it("a shared node instance (DAG) is not mistaken for a cycle", () => {
    const name = Schema.string()
    const doc = Schema.struct({ first: name, last: name })
    expect(computeSchemaHash(doc)).toHaveLength(34)
  })

  it("Schema.tree hashes finitely (recursion is data-level)", () => {
    const tree = Schema.tree(Schema.struct({ label: Schema.string() }))
    expect(computeSchemaHash(tree)).toHaveLength(34)
  })
})

// ===========================================================================
// canonicalTuple structure (functional core) — diagnostic where hashes are
// opaque. The golden vectors below lock the resulting bytes.
// ===========================================================================

describe("canonicalTuple — structure", () => {
  it("wraps a JSON boundary in a 'j' tag around the inner kind tuple", () => {
    expect(
      canonicalTuple(Schema.struct.json({ a: Schema.string() }) as never),
    ).toEqual(["j", ["p", [["a", ["s", "string"]]]]])
  })

  it("emits no boundary tag for a plain struct", () => {
    expect(
      canonicalTuple(Schema.struct({ a: Schema.string() }) as never),
    ).toEqual(["p", [["a", ["s", "string"]]]])
  })
})

describe("computeSchemaHash — golden vectors", () => {
  // Regression lock on the exact "02" bytes. NOT a correctness proof — the
  // injectivity tests above carry correctness. If canonicalization changes,
  // bump HASH_ALGORITHM_VERSION and regenerate these.
  it("SimpleDoc", () => {
    expect(computeSchemaHash(SimpleDoc)).toBe(
      "0233d30c6f4a9819671509aa3883d9a52e",
    )
  })

  it("struct.json({ a: string })", () => {
    expect(computeSchemaHash(Schema.struct.json({ a: Schema.string() }))).toBe(
      "02eb7f5cff73b2f4a020c83a804c9e1962",
    )
  })
})

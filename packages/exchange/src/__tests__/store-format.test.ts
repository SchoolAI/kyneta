// store-format — pure decision + parser tests for the store-format gate.
//
// The policy core is pure, so it carries the bulk of the coverage here;
// per-backend tests only confirm each backend wires the gate to its own
// storage. See `../store/store-format.ts`.

import { describe, expect, it } from "vitest"
import {
  decideStoreFormat,
  parseStoreFormat,
  type StoreFormatVersion,
} from "../store/store-format.js"

const CURRENT: StoreFormatVersion = { major: 1, minor: 0 }

describe("decideStoreFormat", () => {
  it("stamps a brand-new (empty, unmarked) store", () => {
    expect(
      decideStoreFormat({
        current: CURRENT,
        stored: null,
        storeHasData: false,
      }),
    ).toEqual({ action: "stamp", value: CURRENT })
  })

  it("refuses an unmarked store that already holds documents", () => {
    expect(
      decideStoreFormat({ current: CURRENT, stored: null, storeHasData: true }),
    ).toEqual({ action: "refuse", reason: "unversioned-existing-data" })
  })

  it("accepts an exact-version match", () => {
    expect(
      decideStoreFormat({
        current: CURRENT,
        stored: { major: 1, minor: 0 },
        storeHasData: true,
      }),
    ).toEqual({ action: "ok" })
  })

  it("accepts a same-major, different-minor store (backward-compatible)", () => {
    // A newer minor on disk than this build, and vice versa, both read.
    expect(
      decideStoreFormat({
        current: CURRENT,
        stored: { major: 1, minor: 5 },
        storeHasData: true,
      }),
    ).toEqual({ action: "ok" })
    expect(
      decideStoreFormat({
        current: { major: 1, minor: 5 },
        stored: { major: 1, minor: 0 },
        storeHasData: true,
      }),
    ).toEqual({ action: "ok" })
  })

  it("refuses a newer major on disk", () => {
    expect(
      decideStoreFormat({
        current: CURRENT,
        stored: { major: 2, minor: 0 },
        storeHasData: true,
      }),
    ).toEqual({ action: "refuse", reason: "incompatible-major" })
  })

  it("refuses an older major on disk (no down-migration)", () => {
    expect(
      decideStoreFormat({
        current: { major: 2, minor: 0 },
        stored: { major: 1, minor: 0 },
        storeHasData: true,
      }),
    ).toEqual({ action: "refuse", reason: "incompatible-major" })
  })
})

describe("parseStoreFormat", () => {
  it("parses an already-structured object", () => {
    expect(parseStoreFormat({ major: 1, minor: 0 })).toEqual({
      major: 1,
      minor: 0,
    })
  })

  it("parses a JSON string", () => {
    expect(parseStoreFormat('{"major":3,"minor":7}')).toEqual({
      major: 3,
      minor: 7,
    })
  })

  it("rejects malformed values", () => {
    expect(parseStoreFormat(null)).toBe("malformed")
    expect(parseStoreFormat("not json")).toBe("malformed")
    expect(parseStoreFormat({ major: 1 })).toBe("malformed") // missing minor
    expect(parseStoreFormat({ major: "1", minor: 0 })).toBe("malformed") // wrong type
    expect(parseStoreFormat({ major: 1.5, minor: 0 })).toBe("malformed") // non-integer
  })
})

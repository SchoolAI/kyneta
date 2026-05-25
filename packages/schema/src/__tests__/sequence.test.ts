import { describe, expect, it } from "vitest"
import { createDoc, Schema } from "../basic/index.js"

const TestSchema = Schema.struct({
  items: Schema.list(Schema.string()),
})

describe("sequence undefined handling", () => {
  it("synchronously rejects undefined values to prevent CRDT desyncs", () => {
    const doc = createDoc(TestSchema)

    // Test single undefined
    expect(() => doc.items.push(undefined as any)).toThrow(TypeError)

    // Test undefined mixed with valid values
    expect(() => doc.items.push("a", undefined as any, "c")).toThrow(TypeError)

    // Test insert (verifies the core sequenceChange validation catches other methods)
    doc.items.push("a", "b")
    expect(() => doc.items.insert(1, undefined as any)).toThrow(TypeError)
  })
})

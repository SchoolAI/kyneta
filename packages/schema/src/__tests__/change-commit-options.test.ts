// change-commit-options — tests that CommitOptions.origin propagates
// through batch() to Changeset.origin received by subscribers.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { json } from "../bind.js"
import { createDoc } from "../create-doc.js"
import { batch } from "../facade/batch.js"
import { subscribeNode } from "../facade/observe.js"
import { Schema } from "../schema.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const TextDocSchema = Schema.struct({
  title: Schema.text(),
})

// ===========================================================================
// batch(): CommitOptions.origin propagation
// ===========================================================================

describe("change: CommitOptions.origin propagation", () => {
  it("batch() with { origin } propagates origin to Changeset received by subscribers", () => {
    const doc = createDoc(json.bind(TextDocSchema))

    const changesets: Changeset[] = []
    subscribeNode(doc.title, cs => changesets.push(cs))

    batch(
      doc,
      d => {
        d.title.insert(0, "Hello")
      },
      { origin: "my-tag" },
    )

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.origin).toBe("my-tag")
  })

  it("batch() without options produces origin === undefined", () => {
    const doc = createDoc(json.bind(TextDocSchema))

    const changesets: Changeset[] = []
    subscribeNode(doc.title, cs => changesets.push(cs))

    batch(doc, d => {
      d.title.insert(0, "World")
    })

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.origin).toBeUndefined()
  })
})

// ===========================================================================
// batch(): CommitOptions.source propagation (Task 2.1 — source round-trip)
// ===========================================================================

describe("change: CommitOptions.source propagation", () => {
  it("batch() with { source } propagates the identity-typed token to Changeset.source", () => {
    const doc = createDoc(json.bind(TextDocSchema))

    const changesets: Changeset[] = []
    subscribeNode(doc.title, cs => changesets.push(cs))

    const tok = {}
    batch(
      doc,
      d => {
        d.title.insert(0, "Hello")
      },
      { source: tok },
    )

    expect(changesets).toHaveLength(1)
    // Identity, not value equality: the SAME reference round-trips.
    expect(changesets[0]?.source).toBe(tok)
    // A freshly-minted empty object would have the same structural value
    // but a different identity — must NOT match.
    const otherEmpty = {}
    expect(changesets[0]?.source).not.toBe(otherEmpty)
  })

  it("batch() without options produces source === undefined", () => {
    const doc = createDoc(json.bind(TextDocSchema))

    const changesets: Changeset[] = []
    subscribeNode(doc.title, cs => changesets.push(cs))

    batch(doc, d => {
      d.title.insert(0, "World")
    })

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.source).toBeUndefined()
  })

  it("Symbol-typed source tokens round-trip with identity preserved", () => {
    const doc = createDoc(json.bind(TextDocSchema))

    const changesets: Changeset[] = []
    subscribeNode(doc.title, cs => changesets.push(cs))

    const sym = Symbol("test-binding")
    batch(
      doc,
      d => {
        d.title.insert(0, "Sym")
      },
      { source: sym },
    )

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.source).toBe(sym)
  })
})

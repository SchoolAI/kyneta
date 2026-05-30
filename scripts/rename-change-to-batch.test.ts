// Unit test for the pure classifier core of the change→batch codemod.
// Run with: bun test scripts/rename-change-to-batch.test.ts

import { describe, expect, test } from "bun:test"
import { Project, SyntaxKind } from "ts-morph"
import { classifyCall } from "./rename-change-to-batch.ts"

/** Parse a snippet and return its facade call node (callee `batch`/`change`). */
function facadeCall(code: string) {
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile(
    "t.ts",
    code,
  )
  const call = sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((c) => {
      const e = c.getExpression()
      return (
        e.getKind() === SyntaxKind.Identifier &&
        (e.getText() === "batch" || e.getText() === "change")
      )
    })
  if (!call) throw new Error("no facade call found")
  return call
}

describe("classifyCall", () => {
  test("single discarded write (block body) → redundant", () => {
    expect(facadeCall("batch(doc, d => { d.x.set(1) })")).toBeDefined()
    expect(classifyCall(facadeCall("batch(doc, d => { d.x.set(1) })"))).toBe(
      "redundant",
    )
  })

  test("single write (expression body) → redundant", () => {
    expect(classifyCall(facadeCall("batch(doc, d => d.x.set(1))"))).toBe(
      "redundant",
    )
  })

  test("captured return → keep:capture", () => {
    expect(
      classifyCall(facadeCall("const ops = batch(doc, d => { d.x.set(1) })")),
    ).toEqual({ keep: "capture" })
  })

  test("options arg → keep:options", () => {
    expect(
      classifyCall(
        facadeCall("batch(doc, d => { d.x.set(1) }, { source: tok })"),
      ),
    ).toEqual({ keep: "options" })
  })

  test("≥2 writes → keep:multi-write", () => {
    expect(
      classifyCall(facadeCall("batch(doc, d => { d.x.set(1); d.y.set(2) })")),
    ).toEqual({ keep: "multi-write" })
  })
})

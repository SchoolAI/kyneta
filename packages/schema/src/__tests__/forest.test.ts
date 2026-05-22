// forest.test.ts — pure forest helpers (nestForest, flattenForest,
// validateForest, subtreeIds).

import { describe, expect, it } from "vitest"
import {
  type FlatTreeNode,
  type ForestNode,
  flattenForest,
  nestForest,
  subtreeIds,
  validateForest,
} from "../forest.js"

/**
 * Canonical sort: by (parent ?? "", index, id) so flatten + nest are inverse
 * up to ordering. nestForest sorts children by `index` within each parent,
 * so flattenForest reproduces the same canonical ordering.
 */
function canonical<A>(
  flat: readonly FlatTreeNode<A>[],
): readonly FlatTreeNode<A>[] {
  return [...flat].sort((a, b) => {
    const pa = a.parent ?? ""
    const pb = b.parent ?? ""
    if (pa !== pb) return pa < pb ? -1 : 1
    if (a.index !== b.index) return a.index - b.index
    return a.id < b.id ? -1 : 1
  })
}

// ===========================================================================
// nestForest / flattenForest
// ===========================================================================

describe("nestForest / flattenForest", () => {
  it("round-trips a multi-root, multi-level forest", () => {
    // Covers: empty handling, grouping by parent, depth recursion, mixed roots.
    const flat: FlatTreeNode<string>[] = [
      { id: "r1", parent: null, index: 0, data: "root1" },
      { id: "r2", parent: null, index: 1, data: "root2" },
      { id: "c1a", parent: "r1", index: 0, data: "c1a" },
      { id: "c1b", parent: "r1", index: 1, data: "c1b" },
      { id: "gc1", parent: "c1a", index: 0, data: "gc1" },
      { id: "c2a", parent: "r2", index: 0, data: "c2a" },
    ]
    const nested = nestForest(flat)
    expect(nested).toHaveLength(2)
    expect(canonical(flattenForest(nested))).toEqual(canonical(flat))
  })

  it("round-trips an empty forest", () => {
    expect(flattenForest(nestForest([]))).toEqual([])
  })

  it("sorts children by index within each parent", () => {
    const flat: FlatTreeNode<string>[] = [
      { id: "p", parent: null, index: 0, data: "p" },
      { id: "c2", parent: "p", index: 2, data: "c2" },
      { id: "c0", parent: "p", index: 0, data: "c0" },
      { id: "c1", parent: "p", index: 1, data: "c1" },
    ]
    const nested = nestForest(flat)
    expect(nested[0]?.children.map(c => c.id)).toEqual(["c0", "c1", "c2"])
  })

  it("skips orphan nodes (parent id not in node set)", () => {
    const flat: FlatTreeNode<string>[] = [
      { id: "a", parent: null, index: 0, data: "A" },
      { id: "orphan", parent: "missing", index: 0, data: "X" },
    ]
    const nested = nestForest(flat)
    expect(nested).toHaveLength(1)
    expect(nested[0]?.id).toBe("a")
  })

  it("recursive projection reflects depth", () => {
    // Five-level chain — a node at depth N requires N child-walks to reach.
    const flat: FlatTreeNode<number>[] = [
      { id: "a", parent: null, index: 0, data: 1 },
      { id: "b", parent: "a", index: 0, data: 2 },
      { id: "c", parent: "b", index: 0, data: 3 },
      { id: "d", parent: "c", index: 0, data: 4 },
      { id: "e", parent: "d", index: 0, data: 5 },
    ]
    let cur: ForestNode<number> | undefined = nestForest(flat)[0]
    let depth = 0
    while (cur) {
      depth++
      cur = cur.children[0]
    }
    expect(depth).toBe(5)
  })
})

// ===========================================================================
// validateForest
// ===========================================================================

describe("validateForest", () => {
  it("returns no errors for a valid forest", () => {
    expect(
      validateForest([
        { id: "a", parent: null, index: 0, data: 1 },
        { id: "b", parent: null, index: 1, data: 2 },
        { id: "c", parent: "a", index: 0, data: 3 },
      ]),
    ).toEqual([])
  })

  it("flags duplicate id", () => {
    const errors = validateForest([
      { id: "a", parent: null, index: 0, data: 1 },
      { id: "a", parent: null, index: 1, data: 2 },
    ])
    expect(errors[0]?.kind).toBe("duplicate-id")
    expect(errors[0]?.nodeId).toBe("a")
  })

  it("flags missing parent", () => {
    const errors = validateForest([
      { id: "a", parent: "missing", index: 0, data: 1 },
    ])
    expect(errors[0]?.kind).toBe("missing-parent")
  })

  it("flags negative index", () => {
    const errors = validateForest([
      { id: "a", parent: null, index: -1, data: 1 },
    ])
    expect(errors[0]?.kind).toBe("negative-index")
  })

  it("flags a parent cycle", () => {
    const errors = validateForest([
      { id: "a", parent: "c", index: 0, data: 1 },
      { id: "b", parent: "a", index: 0, data: 2 },
      { id: "c", parent: "b", index: 0, data: 3 },
    ])
    expect(errors.some(e => e.kind === "cycle")).toBe(true)
  })
})

// ===========================================================================
// subtreeIds — enumerate descendants
// ===========================================================================

describe("subtreeIds", () => {
  const flat: FlatTreeNode<null>[] = [
    { id: "root", parent: null, index: 0, data: null },
    { id: "a", parent: "root", index: 0, data: null },
    { id: "b", parent: "root", index: 1, data: null },
    { id: "a1", parent: "a", index: 0, data: null },
    { id: "a2", parent: "a", index: 1, data: null },
    { id: "a1x", parent: "a1", index: 0, data: null },
  ]

  it("returns the node and its descendants", () => {
    expect(subtreeIds(flat, "a").slice().sort()).toEqual([
      "a",
      "a1",
      "a1x",
      "a2",
    ])
  })

  it("returns just the leaf for a leaf node", () => {
    expect(subtreeIds(flat, "a1x")).toEqual(["a1x"])
  })

  it("returns empty when the root id is missing or the forest is empty", () => {
    expect(subtreeIds(flat, "nope")).toEqual([])
    expect(subtreeIds([], "any")).toEqual([])
  })

  it("treats sibling roots independently", () => {
    const multi: FlatTreeNode<null>[] = [
      { id: "r1", parent: null, index: 0, data: null },
      { id: "r2", parent: null, index: 1, data: null },
      { id: "r1c", parent: "r1", index: 0, data: null },
      { id: "r2c", parent: "r2", index: 0, data: null },
    ]
    expect(subtreeIds(multi, "r1").slice().sort()).toEqual(["r1", "r1c"])
    expect(subtreeIds(multi, "r2").slice().sort()).toEqual(["r2", "r2c"])
  })
})

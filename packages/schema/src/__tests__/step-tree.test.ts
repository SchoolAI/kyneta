import { describe, expect, it } from "vitest"
import { step, stepTree, treeChange } from "../index.js"

describe("stepTree", () => {
  it("creates a node", () => {
    const result = stepTree(
      [],
      treeChange([
        { action: "create", target: "node-1", parent: null, index: 0 },
      ]),
    )
    expect(result).toEqual([{ id: "node-1", parent: null, index: 0, data: {} }])
  })

  it("deletes a node by target ID", () => {
    const state = [
      { id: "node-1", parent: null, index: 0, data: {} },
      { id: "node-2", parent: null, index: 1, data: {} },
    ]
    const result = stepTree(
      state,
      treeChange([{ action: "delete", target: "node-1" }]),
    )
    expect(result).toEqual([{ id: "node-2", parent: null, index: 1, data: {} }])
  })

  it("moves a node (updates parent and index)", () => {
    const state = [
      { id: "node-1", parent: null, index: 0, data: {} },
      { id: "node-2", parent: null, index: 1, data: {} },
    ]
    const result = stepTree(
      state,
      treeChange([
        { action: "move", target: "node-2", parent: "node-1", index: 0 },
      ]),
    )
    expect(result).toEqual([
      { id: "node-1", parent: null, index: 0, data: {} },
      { id: "node-2", parent: "node-1", index: 0, data: {} },
    ])
  })

  it("handles create + move in sequence", () => {
    const result = stepTree(
      [],
      treeChange([
        { action: "create", target: "root", parent: null, index: 0 },
        { action: "create", target: "child", parent: null, index: 1 },
        { action: "move", target: "child", parent: "root", index: 0 },
      ]),
    )
    expect(result).toEqual([
      { id: "root", parent: null, index: 0, data: {} },
      { id: "child", parent: "root", index: 0, data: {} },
    ])
  })

  it("delete of non-existent target is a no-op", () => {
    const state = [{ id: "node-1", parent: null, index: 0, data: {} }]
    const result = stepTree(
      state,
      treeChange([{ action: "delete", target: "does-not-exist" }]),
    )
    expect(result).toEqual([{ id: "node-1", parent: null, index: 0, data: {} }])
  })

  it("does not mutate the original state array", () => {
    const state = [{ id: "node-1", parent: null, index: 0, data: {} }]
    stepTree(
      state,
      treeChange([
        { action: "create", target: "node-2", parent: null, index: 1 },
      ]),
    )
    expect(state).toEqual([{ id: "node-1", parent: null, index: 0, data: {} }])
  })
})

describe("step dispatcher routes tree changes", () => {
  it("dispatches tree changes via step()", () => {
    const state: unknown[] = []
    const result = step(
      state,
      treeChange([{ action: "create", target: "a", parent: null, index: 0 }]),
    )
    expect(result).toEqual([{ id: "a", parent: null, index: 0, data: {} }])
  })
})

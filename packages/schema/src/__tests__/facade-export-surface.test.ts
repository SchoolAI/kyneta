// facade-export-surface — guards the change() → batch() rename (jj:rkwspltk).
//
// Pins that `batch` is the public mutation-facade verb and `change` is exported
// nowhere, across both schema entrypoints. Catches a half-applied rename and an
// accidental re-introduction of the old name.

import { describe, expect, it } from "vitest"
import * as basic from "../basic/index.js"
import * as schema from "../index.js"

describe("facade export surface: batch, not change", () => {
  it("@kyneta/schema exports batch (function) and not change", () => {
    expect(typeof schema.batch).toBe("function")
    expect("change" in schema).toBe(false)
  })

  it("@kyneta/schema/basic exports batch (function) and not change", () => {
    expect(typeof basic.batch).toBe("function")
    expect("change" in basic).toBe(false)
  })

  it("the companions keep their names", () => {
    expect(typeof schema.applyChanges).toBe("function")
    expect(typeof schema.remove).toBe("function")
  })
})

// export-surface — guards the change() → batch() rename (jj:rkwspltk) at the
// @kyneta/react re-export boundary. `batch` is re-exported; `change` is not.

import { describe, expect, it } from "vitest"
import * as react from "../index.js"

describe("@kyneta/react facade re-export", () => {
  it("re-exports batch (function) and not change", () => {
    expect(typeof react.batch).toBe("function")
    expect("change" in react).toBe(false)
  })
})

import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/testing/index.ts"],
  dts: true,
  sourcemap: true,
  fixedExtension: false,
  outputOptions: {
    // Stable chunk filenames — see jj:szxvyrms for the same pattern in
    // @kyneta/schema. Rolldown's default `[name]-[hash].js` is unstable
    // across builds; placing shared code under `_shared/` keeps filenames
    // deterministic.
    chunkFileNames: "_shared/[name].js",
  },
  deps: {
    // vitest is a devDependency — never bundle it into the testing output.
    neverBundle: ["vitest"],
  },
})

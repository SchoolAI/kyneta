import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/basic/index.ts", "src/testing/index.ts"],
  dts: true,
  sourcemap: true,
  fixedExtension: false,
  outputOptions: {
    // Use a stable chunk name without content hash. Code splitting is required
    // by rolldown when multiple entries share code, but the default
    // `[name]-[hash].js` produces unstable filenames across builds.
    chunkFileNames: "_shared/[name].js",
  },
  deps: {
    // vitest is a devDependency — never bundle it into the testing output.
    neverBundle: ["vitest"],
  },
})

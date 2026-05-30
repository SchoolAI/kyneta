// One-shot: rename facade `change(` → `batch(` in user-facing docs.
//
// JS regex supports lookbehind (ripgrep doesn't), so `(?<![.\w])change\(` is
// the safe facade pattern: it excludes `Exchange(` / `exchange(` (word char
// before) and `x.change(` (property call). The noun-family never matches —
// `Changeset`, `changefeed`, `changeToDiff(`, `ChangeBase`, `op.change`,
// `{ path, change }` all lack a bare `change(`.
//
// EXCLUDED on purpose (historical / internal records — not rewritten):
//   CHANGELOG.md, .plans/**, .jj-plan/**, experimental/**/LEARNINGS.md
// The new 2.0 CHANGELOG entry and semantic rewrites are done by hand.

import { readFileSync, writeFileSync } from "node:fs"

const FILES = [
  "packages/schema/TECHNICAL.md",
  "packages/react/TECHNICAL.md",
  "packages/changefeed/TECHNICAL.md",
  "packages/index/TECHNICAL.md",
  "packages/machine/TECHNICAL.md",
  "packages/exchange/TECHNICAL.md",
  "packages/schema/backends/loro/TECHNICAL.md",
  "packages/schema/backends/yjs/TECHNICAL.md",
  "packages/schema/backends/loro/README.md",
  "packages/schema/backends/yjs/README.md",
  "packages/exchange/README.md",
  "packages/schema/README.md",
  "packages/schema/example/basic/README.md",
  "packages/schema/theory/interpreter-algebra.md",
  "packages/schema/theory/sql.md",
  "ARCHITECTURE.md",
  "README.md",
]

const FACADE_CALL = /(?<![.\w])change\(/g

for (const f of FILES) {
  const before = readFileSync(f, "utf8")
  const n = (before.match(FACADE_CALL) ?? []).length
  const after = before
    .replace(FACADE_CALL, "batch(")
    .replace(/facade\/change\.ts/g, "facade/batch.ts")
    // The "Re-entrant change() inside subscriber callbacks" header is renamed
    // by the rule above; keep its in-doc anchor links pointing at it.
    .replace(/#re-entrant-change-inside/g, "#re-entrant-batch-inside")
  if (after !== before) {
    writeFileSync(f, after)
    console.log(`${f}: ${n} facade change( → batch(`)
  } else {
    console.log(`${f}: (no facade change)`)
  }
}

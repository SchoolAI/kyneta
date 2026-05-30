// One-shot: sweep stale facade `change(` references out of source COMMENTS,
// docstrings, and example display-strings — the AST codemod
// (rename-change-to-batch.ts) only touched real bindings/calls.
//
// Safe as a raw-text pass at this point because every real `change(` *call* in
// code is already `batch(`. What remains is comment/string prose. The pattern
// `(?<![.\w])change\(` (JS lookbehind — ripgrep can't) excludes `Exchange(` /
// `exchange(` (word char before) and `x.change(` (property). The noun-family
// (`Changeset`, `changefeed`, `changeToDiff(`, `op.change`, `{ path, change }`)
// never matches a bare `change(`.
//
// Excludes scripts/ (these codemods document `change(` on purpose),
// node_modules, and dist.

import { readFileSync, writeFileSync } from "node:fs"
import { Glob } from "bun"

const FACADE_CALL = /(?<![.\w])change\(/g
const glob = new Glob("**/*.{ts,tsx}")
let files = 0
let edits = 0

for (const root of ["packages", "examples", "experimental", "tests"]) {
  for (const rel of glob.scanSync({ cwd: root })) {
    if (rel.includes("node_modules/") || rel.includes("dist/")) continue
    const path = `${root}/${rel}`
    const before = readFileSync(path, "utf8")
    const n = (before.match(FACADE_CALL) ?? []).length
    if (n === 0) continue
    writeFileSync(path, before.replace(FACADE_CALL, "batch("))
    files++
    edits += n
    console.log(`${path}: ${n}`)
  }
}
console.log(`\n${edits} residue change( → batch( across ${files} files`)

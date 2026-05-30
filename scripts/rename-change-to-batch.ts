// One-shot codemod: rename the `change()` mutation facade → `batch()`.
//
// WHY a codemod and not an LSP "Rename Symbol": cross-package imports resolve
// to schema's built `dist/*.d.ts`, not its source, so each consumer package is
// a separate TS program and no single rename crosses the seam. We don't need
// cross-program resolution — the facade verb is always imported as the name
// `change`, and that is the ONLY exported binding named `change` in the
// workspace. So we rewrite at the import anchor, file-locally:
//
//   • import/export specifiers named `change`  →  `batch`   (alias preserved)
//   • facade-relative specifier  ./facade/change.js  →  ./facade/batch.js
//   • CallExpression callees `change(`  →  `batch(`   (only in facade-importing
//     files, only for the non-aliased binding)
//
// It NEVER touches `Op.change` (property), `{ path, change }` (destructure),
// `*Change` constructors/guards, `changefeed`, `changeToDiff`, or string
// literals — none of those are a named `change` import or a `change(` callee.
// The legacy `@loro-extended/change` specifier is excluded (cast fixtures
// reference it inside source strings).
//
// Functional core: `classifyCall` (pure) labels every facade call site so the
// shell can print a redundant-single-mutation-wrap report for Phase 3.
// Imperative shell: `main()` (guarded by import.meta.main) applies edits + prints.

import { Glob } from "bun"
import { writeFileSync } from "node:fs"
import { Node, Project, type CallExpression, SyntaxKind, ts } from "ts-morph"

// Module specifier whose `change` named member is NOT our facade.
const EXCLUDED_SPECIFIER = "@loro-extended/change"

// ---------------------------------------------------------------------------
// Functional core — pure classification of a facade call site
// ---------------------------------------------------------------------------

export type CallClass =
  | "redundant"
  | { keep: "capture" | "options" | "multi-write" }

/**
 * Classify a facade call `change(ref, fn, options?)`.
 *
 * - `options` arg present → keep (auto-commit can't carry provenance).
 * - return value used (assigned / returned / passed) → keep:capture.
 * - fn body has ≥2 statements → keep:multi-write (a genuine batch).
 * - fn body is a single statement / expression → redundant (a lone write
 *   that needs no wrapper post auto-commit).
 * - anything unrecognized → keep:multi-write (conservative; never suggest an
 *   unwrap we can't justify).
 */
export function classifyCall(call: CallExpression): CallClass {
  const args = call.getArguments()
  if (args.length >= 3) return { keep: "options" }

  const parent = call.getParent()
  if (
    parent &&
    (Node.isVariableDeclaration(parent) ||
      Node.isReturnStatement(parent) ||
      Node.isCallExpression(parent) ||
      Node.isAwaitExpression(parent) ||
      Node.isPropertyAssignment(parent))
  ) {
    return { keep: "capture" }
  }

  const fn = args[1]
  if (fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
    const body = fn.getBody()
    if (Node.isBlock(body)) {
      return body.getStatements().length >= 2
        ? { keep: "multi-write" }
        : "redundant"
    }
    // Arrow with an expression body — a single mutation expression.
    return "redundant"
  }
  return { keep: "multi-write" }
}

// ---------------------------------------------------------------------------
// Imperative shell
// ---------------------------------------------------------------------------

type Edit = { start: number; end: number; text: string }
type Candidate = { file: string; line: number; snippet: string }

const FACADE_PATH_RE = /(^|\/)facade\/change\.js$/

function rewriteFacadePath(value: string): string {
  return value.replace(/facade\/change\.js$/, "facade/batch.js")
}

function processFile(sf: import("ts-morph").SourceFile): {
  edits: Edit[]
  localNames: Set<string>
  strays: string[]
} {
  const edits: Edit[] = []
  const localNames = new Set<string>()
  const strays: string[] = []

  const handleSpecifier = (
    nameNode: import("ts-morph").Node,
    aliasNode: import("ts-morph").Node | undefined,
  ) => {
    // Rename the imported/exported NAME only; the alias (and code that uses it)
    // stays. Non-aliased bindings drive call-callee renames below.
    edits.push({
      start: nameNode.getStart(),
      end: nameNode.getEnd(),
      text: "batch",
    })
    localNames.add(aliasNode ? aliasNode.getText() : "batch")
  }

  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue()
    if (spec === EXCLUDED_SPECIFIER) continue
    for (const named of imp.getNamedImports()) {
      if (named.getName() === "change")
        handleSpecifier(named.getNameNode(), named.getAliasNode())
    }
    if (FACADE_PATH_RE.test(spec)) {
      const lit = imp.getModuleSpecifier()
      edits.push({
        start: lit.getStart(),
        end: lit.getEnd(),
        text: JSON.stringify(rewriteFacadePath(spec)),
      })
    }
  }

  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue()
    if (spec === EXCLUDED_SPECIFIER) continue
    for (const named of exp.getNamedExports()) {
      if (named.getName() === "change")
        handleSpecifier(named.getNameNode(), named.getAliasNode())
    }
    if (spec && FACADE_PATH_RE.test(spec)) {
      const lit = exp.getModuleSpecifier()
      if (lit)
        edits.push({
          start: lit.getStart(),
          end: lit.getEnd(),
          text: JSON.stringify(rewriteFacadePath(spec)),
        })
    }
  }

  // A non-aliased facade binding means in-file `change(` calls are the facade.
  if (localNames.has("batch")) {
    for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (id.getText() !== "change") continue
      const parent = id.getParent()
      // Skip the import/export specifier name nodes (already handled).
      if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent))
        continue
      // The facade is used as a call callee everywhere in this codebase.
      if (Node.isCallExpression(parent) && parent.getExpression() === id) {
        edits.push({ start: id.getStart(), end: id.getEnd(), text: "batch" })
        continue
      }
      // Property access member (`x.change`), destructure, key, etc. are NOT
      // the facade — leave them. Anything else referencing the binding is a
      // stray we log for manual review (none expected in this codebase).
      if (
        Node.isPropertyAccessExpression(parent) ||
        Node.isBindingElement(parent) ||
        Node.isPropertyAssignment(parent) ||
        Node.isShorthandPropertyAssignment(parent) ||
        Node.isPropertySignature(parent)
      ) {
        continue
      }
      strays.push(`${sf.getFilePath()}:${id.getStartLineNumber()}`)
    }
  }

  return { edits, localNames, strays }
}

function collectCandidates(sf: import("ts-morph").SourceFile): Candidate[] {
  // Re-scan for facade call sites (callee `change`, since edits not yet
  // applied) and classify. Only meaningful in facade-importing files, but the
  // callee name uniquely identifies the facade so scanning is safe.
  const out: Candidate[] = []
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    if (!Node.isIdentifier(callee) || callee.getText() !== "change") continue
    if (classifyCall(call) === "redundant") {
      out.push({
        file: sf.getFilePath(),
        line: call.getStartLineNumber(),
        snippet: call.getText().split("\n")[0].slice(0, 80),
      })
    }
  }
  return out
}

function applyEdits(text: string, edits: Edit[]): string {
  // Apply non-overlapping edits right-to-left so offsets stay valid.
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

function main() {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve },
  })

  // Enumerate files ourselves (skipping node_modules/dist) rather than letting
  // ts-morph walk the tree — pnpm's deep node_modules symlinks blow up its glob.
  const glob = new Glob("**/*.{ts,tsx}")
  for (const root of ["packages", "examples", "experimental", "tests"]) {
    for (const rel of glob.scanSync({ cwd: root })) {
      if (rel.includes("node_modules/") || rel.includes("dist/")) continue
      project.addSourceFileAtPath(`${root}/${rel}`)
    }
  }

  let filesChanged = 0
  let batchEdits = 0
  const allStrays: string[] = []
  const candidates: Candidate[] = []

  for (const sf of project.getSourceFiles()) {
    const { edits, strays } = processFile(sf)
    candidates.push(...collectCandidates(sf))
    allStrays.push(...strays)
    if (edits.length === 0) continue
    const original = sf.getFullText()
    const next = applyEdits(original, edits)
    writeFileSync(sf.getFilePath(), next)
    filesChanged++
    batchEdits += edits.filter((e) => e.text === "batch").length
  }

  console.log(`\n=== rename change → batch ===`)
  console.log(`files changed: ${filesChanged}`)
  console.log(`identifier/specifier renames (→ batch): ${batchEdits}`)
  if (allStrays.length) {
    console.log(`\n⚠ stray facade references (manual review):`)
    for (const s of allStrays) console.log(`  ${s}`)
  } else {
    console.log(`no stray facade references`)
  }
  console.log(
    `\n=== redundant single-mutation wraps (Phase 3 candidates: ${candidates.length}) ===`,
  )
  for (const c of candidates) {
    const rel = c.file.replace(`${process.cwd()}/`, "")
    console.log(`  ${rel}:${c.line}  ${c.snippet}`)
  }
}

if (import.meta.main) main()

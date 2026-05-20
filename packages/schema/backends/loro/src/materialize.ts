// materialize — Loro→PlainState materialization via generic resolver.
//
// Implements `createLoroResolver`, a closure-based `MaterializeResolver`
// that navigates the Loro container tree via `resolveContainer`. The
// generic `createMaterializeInterpreter` drives the catamorphism; the
// resolver handles only the CRDT-specific value extraction.
//
// Zero fallback for missing values (e.g. nested nullable fields on a
// fresh doc) is handled canonically by the generic interpreter — not
// inlined here.

import type {
  FlatTreeNodeTopology,
  MaterializeResolver,
  Path,
  PlainState,
  RichTextDelta,
  SchemaBinding,
  Schema as SchemaNode,
} from "@kyneta/schema"
import {
  createMaterializeInterpreter,
  interpret,
  isNonNullObject,
  materializeContextFromResolver,
} from "@kyneta/schema"
import type { Delta, LoroDoc } from "loro-crdt"
import { extractValue, loroDeltaToRichTextDelta } from "./loro-extract.js"
import { hasKind } from "./loro-guards.js"
import { resolveContainer } from "./loro-resolve.js"

// ---------------------------------------------------------------------------
// Loro resolver
// ---------------------------------------------------------------------------

function createLoroResolver(
  doc: LoroDoc,
  rootSchema: SchemaNode,
  binding?: SchemaBinding,
): MaterializeResolver {
  return {
    resolveValue(path: Path): unknown {
      const result = resolveContainer(doc, rootSchema, path, binding)
      return extractValue(result.container)
    },

    resolveText(path: Path): string | undefined {
      const { container } = resolveContainer(doc, rootSchema, path, binding)
      if (hasKind(container) && container.kind() === "Text") {
        return (container as any).toString() as string
      }
      const value = extractValue(container)
      return typeof value === "string" ? value : undefined
    },

    resolveCounter(path: Path): number | undefined {
      const { container } = resolveContainer(doc, rootSchema, path, binding)
      if (hasKind(container) && container.kind() === "Counter") {
        return (container as any).value as number
      }
      const value = extractValue(container)
      return typeof value === "number" ? value : undefined
    },

    resolveRichText(path: Path): RichTextDelta | undefined {
      const { container } = resolveContainer(doc, rootSchema, path, binding)
      if (hasKind(container) && container.kind() === "Text") {
        const deltas = (container as any).toDelta() as Delta<string>[]
        return loroDeltaToRichTextDelta(deltas)
      }
      return undefined
    },

    resolveLength(path: Path): number {
      const { container } = resolveContainer(doc, rootSchema, path, binding)
      if (!hasKind(container)) {
        return Array.isArray(container) ? container.length : 0
      }
      const kind = container.kind()
      if (kind === "List" || kind === "MovableList") {
        return (container as any).length as number
      }
      return 0
    },

    resolveKeys(path: Path): string[] {
      const { container } = resolveContainer(doc, rootSchema, path, binding)
      if (!hasKind(container)) {
        return isNonNullObject(container) ? Object.keys(container) : []
      }
      if (container.kind() === "Map") {
        return (container as any).keys() as string[]
      }
      return []
    },

    resolveForest(path: Path): readonly FlatTreeNodeTopology[] {
      const { container } = resolveContainer(doc, rootSchema, path, binding)
      if (!hasKind(container) || container.kind() !== "Tree") return []
      const rows = (container as any).toArray() as Array<{
        id: string
        parent: string | null | undefined
        index: number
      }>
      return rows.map(row => ({
        id: row.id,
        parent: row.parent ?? null,
        index: row.index,
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function materializeLoroShadow(
  doc: LoroDoc,
  schema: SchemaNode,
  binding?: SchemaBinding,
): PlainState {
  const resolver = createLoroResolver(doc, schema, binding)
  const interp = createMaterializeInterpreter(resolver)
  const ctx = materializeContextFromResolver(resolver)
  const result = interpret(schema, interp, ctx)
  return result as PlainState
}

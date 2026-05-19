// materialize — Interpreter-driven Loro→PlainState materialization.
//
// Walks a LoroDoc in parallel with the schema tree using the generic
// catamorphism (`interpret`), producing a PlainState (plain JS object).
//
// Each interpreter case resolves the Loro container at the current path
// via `resolveContainer`, then extracts or recurses as appropriate.
// The catamorphism handles path threading, sum dispatch, and child
// thunking — no bespoke walker needed.

import type {
  CounterSchema,
  Interpreter,
  MapSchema,
  MovableSequenceSchema,
  Path,
  PlainState,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  SchemaBinding,
  Schema as SchemaNode,
  SequenceSchema,
  SetSchema,
  SumSchema,
  SumVariants,
  TextSchema,
  TreeSchema,
} from "@kyneta/schema"
import { interpret, isNonNullObject, scalarDefault } from "@kyneta/schema"
import type { Delta, LoroDoc } from "loro-crdt"
import { extractValue, loroDeltaToRichTextDelta } from "./loro-extract.js"
import { hasKind } from "./loro-guards.js"
import { resolveContainer } from "./loro-resolve.js"

// ---------------------------------------------------------------------------
// Interpreter context
// ---------------------------------------------------------------------------

interface LoroMaterializeCtx {
  readonly doc: LoroDoc
  readonly rootSchema: SchemaNode
  readonly binding?: SchemaBinding
}

// ---------------------------------------------------------------------------
// Loro materialize interpreter
// ---------------------------------------------------------------------------

/**
 * An interpreter that reads from a LoroDoc and produces plain JS values.
 *
 * Each case resolves the Loro container at the given path using
 * `resolveContainer`, then extracts the appropriate value. Container
 * types (sequence, map, set, movable) enumerate their children and
 * delegate to the item thunks provided by the catamorphism.
 */
const loroMaterializeInterpreter: Interpreter<
  LoroMaterializeCtx,
  unknown
> = {
  scalar(ctx: LoroMaterializeCtx, path: Path, schema: ScalarSchema): unknown {
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const result = resolveContainer(ctx.doc, ctx.rootSchema, path, ctx.binding)
    const value = extractValue(result.container)
    // Fall back to the structural zero when the CRDT has no value
    // (e.g. nested scalar fields that were never explicitly set).
    if (value === undefined) {
      if (schema.constraint !== undefined && schema.constraint.length > 0) {
        return schema.constraint[0]
      }
      return scalarDefault(schema.scalarKind)
    }
    return value
  },

  product(
    _ctx: LoroMaterializeCtx,
    _path: Path,
    _schema: ProductSchema,
    fields: Readonly<Record<string, () => unknown>>,
  ): unknown {
    // Force all field thunks — eagerly build the full plain object.
    const result: Record<string, unknown> = {}
    for (const [key, thunk] of Object.entries(fields)) {
      result[key] = thunk()
    }
    return result
  },

  sequence(
    ctx: LoroMaterializeCtx,
    path: Path,
    _schema: SequenceSchema,
    item: (index: number) => unknown,
  ): unknown {
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const { container } = resolveContainer(
      ctx.doc,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (!hasKind(container)) {
      return Array.isArray(container) ? container : []
    }
    const kind = container.kind()
    if (kind === "List" || kind === "MovableList") {
      const length = (container as any).length as number
      const result: unknown[] = []
      for (let i = 0; i < length; i++) {
        result.push(item(i))
      }
      return result
    }
    return []
  },

  map(
    ctx: LoroMaterializeCtx,
    path: Path,
    _schema: MapSchema,
    item: (key: string) => unknown,
  ): unknown {
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const { container } = resolveContainer(
      ctx.doc,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (!hasKind(container)) {
      if (isNonNullObject(container)) {
        const result: Record<string, unknown> = {}
        for (const key of Object.keys(container)) {
          result[key] = item(key)
        }
        return result
      }
      return {}
    }
    const kind = container.kind()
    if (kind === "Map") {
      const keys = (container as any).keys() as string[]
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        result[key] = item(key)
      }
      return result
    }
    return {}
  },

  sum(
    ctx: LoroMaterializeCtx,
    path: Path,
    schema: SumSchema,
    variants: SumVariants<unknown>,
  ): unknown {
    // For discriminated sums, read the discriminant from the resolved value
    // and dispatch through the matching variant.
    if (schema.discriminant !== undefined && variants.byKey) {
      if (path.length === 0) {
        const value = (ctx.doc as any).toJSON()
        if (isNonNullObject(value)) {
          const discValue = value[schema.discriminant]
          if (typeof discValue === "string") {
            return variants.byKey(discValue)
          }
        }
        return value
      }
      const result = resolveContainer(
        ctx.doc,
        ctx.rootSchema,
        path,
        ctx.binding,
      )
      const value = extractValue(result.container)
      if (isNonNullObject(value)) {
        const discValue = value[schema.discriminant]
        if (typeof discValue === "string") {
          return variants.byKey(discValue)
        }
      }
      return value
    }

    // Positional sums — return the raw value.
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const result = resolveContainer(
      ctx.doc,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    return extractValue(result.container)
  },

  text(
    ctx: LoroMaterializeCtx,
    path: Path,
    _schema: TextSchema,
  ): unknown {
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const { container } = resolveContainer(
      ctx.doc,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (hasKind(container) && container.kind() === "Text") {
      return (container as any).toString()
    }
    return extractValue(container)
  },

  counter(
    ctx: LoroMaterializeCtx,
    path: Path,
    _schema: CounterSchema,
  ): unknown {
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const { container } = resolveContainer(
      ctx.doc,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (hasKind(container) && container.kind() === "Counter") {
      return (container as any).value as number
    }
    return extractValue(container)
  },

  set(
    ctx: LoroMaterializeCtx,
    path: Path,
    _schema: SetSchema,
    item: (key: string) => unknown,
  ): unknown {
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const { container } = resolveContainer(
      ctx.doc,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (!hasKind(container)) {
      if (isNonNullObject(container)) {
        const result: Record<string, unknown> = {}
        for (const key of Object.keys(container)) {
          result[key] = item(key)
        }
        return result
      }
      return {}
    }
    const kind = container.kind()
    if (kind === "Map") {
      const keys = (container as any).keys() as string[]
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        result[key] = item(key)
      }
      return result
    }
    return {}
  },

  tree(
    _ctx: LoroMaterializeCtx,
    _path: Path,
    _schema: TreeSchema,
    nodeData: () => unknown,
  ): unknown {
    // Transparent — the catamorphism handles recursion via nodeData.
    return nodeData()
  },

  movable(
    ctx: LoroMaterializeCtx,
    path: Path,
    _schema: MovableSequenceSchema,
    item: (index: number) => unknown,
  ): unknown {
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const { container } = resolveContainer(
      ctx.doc,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (!hasKind(container)) {
      return Array.isArray(container) ? container : []
    }
    const kind = container.kind()
    if (kind === "MovableList" || kind === "List") {
      const length = (container as any).length as number
      const result: unknown[] = []
      for (let i = 0; i < length; i++) {
        result.push(item(i))
      }
      return result
    }
    return []
  },

  richtext(
    ctx: LoroMaterializeCtx,
    path: Path,
    _schema: RichTextSchema,
  ): unknown {
    if (path.length === 0) {
      return (ctx.doc as any).toJSON()
    }
    const { container } = resolveContainer(
      ctx.doc,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    // Rich text: use toDelta() and convert to RichTextDelta
    if (hasKind(container) && container.kind() === "Text") {
      const deltas = (container as any).toDelta() as Delta<string>[]
      return loroDeltaToRichTextDelta(deltas)
    }
    return extractValue(container)
  },
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Materialize a LoroDoc into a PlainState by walking the schema tree.
 *
 * Uses the generic `interpret` catamorphism with a Loro-specific
 * interpreter that resolves containers at each path and extracts
 * plain values.
 *
 * @param doc - The LoroDoc to materialize.
 * @param schema - The root schema describing the document structure.
 * @param binding - Optional identity binding for key remapping.
 * @returns A PlainState (plain JS object) mirroring the doc contents.
 */
export function materializeLoroShadow(
  doc: LoroDoc,
  schema: SchemaNode,
  binding?: SchemaBinding,
): PlainState {
  const ctx: LoroMaterializeCtx = { doc, rootSchema: schema, binding }
  const result = interpret(schema, loroMaterializeInterpreter, ctx)
  return result as PlainState
}

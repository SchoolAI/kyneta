// materialize — Interpreter-driven Yjs→PlainState materialization.
//
// Walks a Y.Doc in parallel with the schema tree using the generic
// catamorphism (`interpret`), producing a PlainState (plain JS object).
//
// Each interpreter case resolves the Yjs shared type at the current path
// via `resolveYjsType`, then extracts or recurses as appropriate.
// The catamorphism handles path threading, sum dispatch, and child
// thunking — no bespoke walker needed.
//
// Unsupported types (counter, tree, movable) return sensible defaults
// since schemas using them are rejected at bind time.

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
import * as Y from "yjs"
import { extractValue, yTextToRichTextDelta } from "./yjs-extract.js"
import { resolveYjsType } from "./yjs-resolve.js"

// ---------------------------------------------------------------------------
// Interpreter context
// ---------------------------------------------------------------------------

interface YjsMaterializeCtx {
  readonly rootMap: Y.Map<any>
  readonly rootSchema: SchemaNode
  readonly binding?: SchemaBinding
}

// ---------------------------------------------------------------------------
// Yjs materialize interpreter
// ---------------------------------------------------------------------------

/**
 * An interpreter that reads from a Y.Doc and produces plain JS values.
 *
 * Each case resolves the Yjs shared type at the given path using
 * `resolveYjsType`, then extracts the appropriate value. Container
 * types (sequence, map, set) enumerate their children and delegate
 * to the item thunks provided by the catamorphism.
 */
const yjsMaterializeInterpreter: Interpreter<YjsMaterializeCtx, unknown> = {
  scalar(
    ctx: YjsMaterializeCtx,
    path: Path,
    schema: ScalarSchema,
  ): unknown {
    if (path.length === 0) {
      return ctx.rootMap.toJSON()
    }
    const result = resolveYjsType(
      ctx.rootMap,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    const value = extractValue(result.resolved)
    // Fall back to the structural zero when the CRDT has no value.
    if (value === undefined) {
      if (schema.constraint !== undefined && schema.constraint.length > 0) {
        return schema.constraint[0]
      }
      return scalarDefault(schema.scalarKind)
    }
    return value
  },

  product(
    _ctx: YjsMaterializeCtx,
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
    ctx: YjsMaterializeCtx,
    path: Path,
    _schema: SequenceSchema,
    item: (index: number) => unknown,
  ): unknown {
    if (path.length === 0) {
      return ctx.rootMap.toJSON()
    }
    const { resolved } = resolveYjsType(
      ctx.rootMap,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (resolved instanceof Y.Array) {
      const length = resolved.length
      const result: unknown[] = []
      for (let i = 0; i < length; i++) {
        result.push(item(i))
      }
      return result
    }
    if (Array.isArray(resolved)) {
      return resolved
    }
    return []
  },

  map(
    ctx: YjsMaterializeCtx,
    path: Path,
    _schema: MapSchema,
    item: (key: string) => unknown,
  ): unknown {
    if (path.length === 0) {
      return ctx.rootMap.toJSON()
    }
    const { resolved } = resolveYjsType(
      ctx.rootMap,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (resolved instanceof Y.Map) {
      const keys = Array.from(resolved.keys())
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        result[key] = item(key)
      }
      return result
    }
    if (isNonNullObject(resolved)) {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(resolved)) {
        result[key] = item(key)
      }
      return result
    }
    return {}
  },

  sum(
    ctx: YjsMaterializeCtx,
    path: Path,
    schema: SumSchema,
    variants: SumVariants<unknown>,
  ): unknown {
    // For discriminated sums, read the discriminant from the resolved value
    // and dispatch through the matching variant.
    if (schema.discriminant !== undefined && variants.byKey) {
      if (path.length === 0) {
        const value = ctx.rootMap.toJSON()
        if (isNonNullObject(value)) {
          const discValue = value[schema.discriminant]
          if (typeof discValue === "string") {
            return variants.byKey(discValue)
          }
        }
        return value
      }
      const result = resolveYjsType(
        ctx.rootMap,
        ctx.rootSchema,
        path,
        ctx.binding,
      )
      const value = extractValue(result.resolved)
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
      return ctx.rootMap.toJSON()
    }
    const result = resolveYjsType(
      ctx.rootMap,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    return extractValue(result.resolved)
  },

  text(
    ctx: YjsMaterializeCtx,
    path: Path,
    _schema: TextSchema,
  ): unknown {
    if (path.length === 0) {
      return ctx.rootMap.toJSON()
    }
    const { resolved } = resolveYjsType(
      ctx.rootMap,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (resolved instanceof Y.Text) {
      return resolved.toJSON()
    }
    return extractValue(resolved)
  },

  // Yjs does not support counters — schemas with counter types are
  // rejected at bind time. Return a sensible default.
  counter(
    _ctx: YjsMaterializeCtx,
    _path: Path,
    _schema: CounterSchema,
  ): unknown {
    return 0
  },

  set(
    ctx: YjsMaterializeCtx,
    path: Path,
    _schema: SetSchema,
    item: (key: string) => unknown,
  ): unknown {
    if (path.length === 0) {
      return ctx.rootMap.toJSON()
    }
    const { resolved } = resolveYjsType(
      ctx.rootMap,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (resolved instanceof Y.Map) {
      const keys = Array.from(resolved.keys())
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        result[key] = item(key)
      }
      return result
    }
    if (isNonNullObject(resolved)) {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(resolved)) {
        result[key] = item(key)
      }
      return result
    }
    return {}
  },

  // Yjs does not support tree — schemas with tree types are
  // rejected at bind time. Return a sensible default.
  tree(
    _ctx: YjsMaterializeCtx,
    _path: Path,
    _schema: TreeSchema,
    _nodeData: () => unknown,
  ): unknown {
    return {}
  },

  // Yjs does not support movable sequences — schemas with movable types
  // are rejected at bind time. Return a sensible default.
  movable(
    _ctx: YjsMaterializeCtx,
    _path: Path,
    _schema: MovableSequenceSchema,
    _item: (index: number) => unknown,
  ): unknown {
    return []
  },

  richtext(
    ctx: YjsMaterializeCtx,
    path: Path,
    _schema: RichTextSchema,
  ): unknown {
    if (path.length === 0) {
      return ctx.rootMap.toJSON()
    }
    const { resolved } = resolveYjsType(
      ctx.rootMap,
      ctx.rootSchema,
      path,
      ctx.binding,
    )
    if (resolved instanceof Y.Text) {
      return yTextToRichTextDelta(resolved)
    }
    return extractValue(resolved)
  },
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Materialize a Y.Doc into a PlainState by walking the schema tree.
 *
 * Uses the generic `interpret` catamorphism with a Yjs-specific
 * interpreter that resolves shared types at each path and extracts
 * plain values.
 *
 * @param doc - The Y.Doc to materialize.
 * @param schema - The root schema describing the document structure.
 * @param binding - Optional identity binding for key remapping.
 * @returns A PlainState (plain JS object) mirroring the doc contents.
 */
export function materializeYjsShadow(
  doc: Y.Doc,
  schema: SchemaNode,
  binding?: SchemaBinding,
): PlainState {
  const rootMap = doc.getMap("root")
  const ctx: YjsMaterializeCtx = { rootMap, rootSchema: schema, binding }
  const result = interpret(schema, yjsMaterializeInterpreter, ctx)
  return result as PlainState
}

// Materialize interpreter — builds plain values from a backend-agnostic resolver.
//
// The 11 interpreter cases partition cleanly into two families:
//
// 1. **Container cases** (backend-agnostic) — product and tree delegate
//    structurally without touching the resolver. Product forces all field
//    thunks into a record; tree delegates via nodeData.
//
// 2. **Resolution cases** — the remaining 9 cases call one of 6 resolver
//    methods, split into two sub-families:
//
//    - **Leaf resolvers** (return typed value or undefined = not present):
//      resolveValue (scalar, sum), resolveText, resolveCounter, resolveRichText
//
//    - **Container shape resolvers** (return structure metadata):
//      resolveLength (sequence, movable), resolveKeys (map, set)
//
// Zero fallback is delegated to `zeroInterpreter` (for scalars with
// constraint handling) and `Zero.structural` (for sum defaults). This
// avoids duplicating default-value logic.
//
// The closure-based design parallels `plainReader(state)` — the resolver
// closes over backend state, eliminating Ctx threading. The interpreter's
// Ctx is `void` because all state access is captured in the resolver.

import type { RichTextDelta } from "../change.js"
import { isNonNullObject } from "../guards.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import { isNullableSum } from "../schema.js"
import { Zero, zeroInterpreter } from "../zero.js"

// ---------------------------------------------------------------------------
// MaterializeResolver — backend-agnostic value resolution
// ---------------------------------------------------------------------------

export interface MaterializeResolver {
  // --- Leaf resolvers (return typed value or undefined = not present) ---
  resolveValue(path: Path): unknown
  resolveText(path: Path): string | undefined
  resolveCounter(path: Path): number | undefined
  resolveRichText(path: Path): RichTextDelta | undefined

  // --- Container shape resolvers ---
  resolveLength(path: Path): number
  resolveKeys(path: Path): string[]
}

// ---------------------------------------------------------------------------
// createMaterializeInterpreter
// ---------------------------------------------------------------------------

export function createMaterializeInterpreter(
  resolver: MaterializeResolver,
): Interpreter<void, unknown> {
  return {
    // 1. scalar — resolve value, falling back to zeroInterpreter for defaults
    scalar(_ctx: undefined, path: Path, schema: ScalarSchema): unknown {
      const value = resolver.resolveValue(path)
      if (value === undefined) {
        return zeroInterpreter.scalar(undefined, path, schema)
      }
      return value
    },

    // 2. product — container case, no resolver needed
    product(
      _ctx: undefined,
      _path: Path,
      _schema: ProductSchema,
      fields: Readonly<Record<string, () => unknown>>,
    ): unknown {
      const result: Record<string, unknown> = {}
      for (const [key, thunk] of Object.entries(fields)) {
        result[key] = thunk()
      }
      return result
    },

    // 3. sequence — resolve length, iterate items
    sequence(
      _ctx: undefined,
      path: Path,
      _schema: SequenceSchema,
      item: (index: number) => unknown,
    ): unknown {
      const length = resolver.resolveLength(path)
      const result: unknown[] = []
      for (let i = 0; i < length; i++) {
        result.push(item(i))
      }
      return result
    },

    // 4. map — resolve keys, iterate items
    map(
      _ctx: undefined,
      path: Path,
      _schema: MapSchema,
      item: (key: string) => unknown,
    ): unknown {
      const keys = resolver.resolveKeys(path)
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        result[key] = item(key)
      }
      return result
    },

    // 5. sum — discriminated or positional dispatch
    sum(
      _ctx: undefined,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<unknown>,
    ): unknown {
      // Discriminated sum
      if (schema.discriminant !== undefined && variants.byKey) {
        const value = resolver.resolveValue(path)
        if (isNonNullObject(value)) {
          const discValue = value[schema.discriminant]
          if (typeof discValue === "string") {
            return variants.byKey(discValue)
          }
        }
        return Zero.structural(schema)
      }

      // Positional sum
      if (variants.byIndex) {
        const value = resolver.resolveValue(path)
        if (value === undefined) {
          return Zero.structural(schema)
        }
        const posSchema = schema as PositionalSumSchema
        if (isNullableSum(posSchema)) {
          return value === null ? variants.byIndex(0) : variants.byIndex(1)
        }
        return variants.byIndex(0)
      }

      return Zero.structural(schema)
    },

    // 6. text — resolve text, default to ""
    text(_ctx: undefined, path: Path, _schema: TextSchema): unknown {
      return resolver.resolveText(path) ?? ""
    },

    // 7. counter — resolve counter, default to 0
    counter(_ctx: undefined, path: Path, _schema: CounterSchema): unknown {
      return resolver.resolveCounter(path) ?? 0
    },

    // 8. set — same pattern as map
    set(
      _ctx: undefined,
      path: Path,
      _schema: SetSchema,
      item: (key: string) => unknown,
    ): unknown {
      const keys = resolver.resolveKeys(path)
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        result[key] = item(key)
      }
      return result
    },

    // 9. tree — container case, delegate via nodeData
    tree(
      _ctx: undefined,
      _path: Path,
      _schema: TreeSchema,
      nodeData: () => unknown,
    ): unknown {
      return nodeData()
    },

    // 10. movable — same pattern as sequence
    movable(
      _ctx: undefined,
      path: Path,
      _schema: MovableSequenceSchema,
      item: (index: number) => unknown,
    ): unknown {
      const length = resolver.resolveLength(path)
      const result: unknown[] = []
      for (let i = 0; i < length; i++) {
        result.push(item(i))
      }
      return result
    },

    // 11. richtext — resolve rich text, default to []
    richtext(_ctx: undefined, path: Path, _schema: RichTextSchema): unknown {
      return resolver.resolveRichText(path) ?? []
    },
  }
}

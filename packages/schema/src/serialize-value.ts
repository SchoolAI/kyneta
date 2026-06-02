// serialize-value — canonical serialization of a scalar constraint /
// discriminant-tag value to a string.
//
// Single source of truth shared by `hash.ts` (canonical schema
// fingerprinting), `describe.ts`, and `validate.ts`, so the three can
// never drift. `JSON.stringify` is injective across the realistic
// constraint value domain (strings, finite numbers, booleans, null):
// `1` → `1`, `"1"` → `"1"` (quoted), `true`/`null` distinct — which is
// exactly what a content-addressed hash needs and what the human-facing
// "one of …" messages already produced.
//
// Always returns a string:
//   - `undefined` (which `JSON.stringify` maps to the JS value
//     `undefined`) → the literal `"undefined"`.
//   - values `JSON.stringify` cannot encode (e.g. `bigint`) → `String(v)`
//     rather than throwing. Vanishingly unlikely for a constraint, but
//     keeps all three callers total.

export function serializeConstraintValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined"
  } catch {
    return String(value)
  }
}

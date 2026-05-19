// reconnect — shared reconnection utilities for client transports.
//
// Pure backoff math and a pure reconnect-decision function. The imperative
// scheduling (setTimeout, retry) lives inside each transport's client program.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Reconnect configuration — shared across all client transports. */
export interface ReconnectOptions {
  enabled: boolean
  maxAttempts: number
  baseDelay: number
  maxDelay: number
}

export const DEFAULT_RECONNECT: ReconnectOptions = {
  enabled: true,
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
}

/**
 * One-sided jitter fraction: with `random ∈ [0, 1)`, the multiplier sits in
 * `[1.0, 1.2)`. Jitter only *adds* 0–20% of the raw delay — we never want a
 * client to reconnect *faster* than `baseDelay`, so the perturbation is
 * additive, not symmetric.
 */
export const JITTER_FRACTION = 0.2

// ---------------------------------------------------------------------------
// Functional core — pure backoff computation
// ---------------------------------------------------------------------------

/**
 * Compute the reconnection delay for a 1-based `attempt`.
 *
 * `random` is the externally-supplied `[0, 1)` source (typically `Math.random()`);
 * splitting it out of the function lets tests pin a deterministic delay.
 * Clamping to `maxDelay` happens *after* jitter so the jittered upper bound
 * cannot exceed `maxDelay`.
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  random: number,
): number {
  const rawDelay = baseDelay * 2 ** (attempt - 1)
  const jittered = rawDelay * (1 + random * JITTER_FRACTION)
  return Math.min(jittered, maxDelay)
}

// ---------------------------------------------------------------------------
// Reconnect decision
// ---------------------------------------------------------------------------

/**
 * Two `reconnect: false` variants exist because callers build *different*
 * transport-specific `DisconnectReason` values from them:
 * - `"disabled"` → caller propagates its own original reason (the error or
 *   close that triggered the check).
 * - `"max-attempts-exceeded"` → caller constructs a synthetic
 *   `{ type: "max-retries-exceeded", attempts }` reason.
 *
 * A bare `{ reconnect: false }` would force callers to re-check `opts.enabled`
 * themselves, defeating the consolidation.
 */
export type ReconnectDecision =
  | {
      readonly reconnect: true
      readonly attempt: number
      readonly delayMs: number
    }
  | { readonly reconnect: false; readonly cause: "disabled" }
  | {
      readonly reconnect: false
      readonly cause: "max-attempts-exceeded"
      readonly attempts: number
    }

/**
 * `currentAttempt` is the attempt count *before* this decision (0 if the
 * client has not yet retried). When the decision is `reconnect: true`,
 * `attempt` is `currentAttempt + 1` — i.e. the attempt the caller is about
 * to schedule.
 */
export function shouldReconnect(
  opts: ReconnectOptions,
  currentAttempt: number,
  randomFn: () => number,
): ReconnectDecision {
  if (!opts.enabled) {
    return { reconnect: false, cause: "disabled" }
  }

  if (currentAttempt >= opts.maxAttempts) {
    return {
      reconnect: false,
      cause: "max-attempts-exceeded",
      attempts: currentAttempt,
    }
  }

  const attempt = currentAttempt + 1
  const delayMs = computeBackoffDelay(
    attempt,
    opts.baseDelay,
    opts.maxDelay,
    randomFn(),
  )
  return { reconnect: true, attempt, delayMs }
}

// client-program — pure Mealy machine for unix socket client connection lifecycle.
//
// The client program encodes every state transition and effect as data.
// The imperative shell (client-transport.ts) interprets effects as I/O.
// Tests assert on data — no sockets, no timing, never flaky.
//
// Algebra: Program<UnixSocketClientMsg, UnixSocketClientState, UnixSocketClientEffect>
// Interpreter: client-transport.ts executeClientEffect()

import type { Program } from "@kyneta/machine"
import type { ReconnectOptions } from "@kyneta/transport"
import { DEFAULT_RECONNECT, shouldReconnect } from "@kyneta/transport"

import type { DisconnectReason, UnixSocketClientState } from "./types.js"

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type UnixSocketClientMsg =
  | { type: "start" }
  | { type: "connection-opened" }
  | { type: "connection-closed" }
  | { type: "connection-error"; error: Error; errno?: string }
  | { type: "reconnect-timer-fired" }
  | { type: "stop" }

// ---------------------------------------------------------------------------
// Effects (data — interpreted by the imperative shell)
// ---------------------------------------------------------------------------

export type UnixSocketClientEffect =
  | { type: "connect"; path: string; attempt: number }
  | { type: "close-connection" }
  | { type: "add-channel-and-establish" }
  | { type: "remove-channel" }
  | { type: "start-reconnect-timer"; delayMs: number }
  | { type: "cancel-reconnect-timer" }

// ---------------------------------------------------------------------------
// Program factory
// ---------------------------------------------------------------------------

export interface UnixSocketClientProgramOptions {
  path: string
  reconnect?: Partial<ReconnectOptions>
  /** Source of `[0, 1)` random values for jitter. Default: `Math.random` */
  randomFn?: () => number
}

/**
 * Create the client connection lifecycle program — a pure Mealy machine.
 *
 * The returned `Program<UnixSocketClientMsg, UnixSocketClientState, UnixSocketClientEffect>`
 * encodes every state transition and effect as inspectable data. The imperative
 * shell interprets `UnixSocketClientEffect` as actual I/O.
 */
export function createUnixSocketClientProgram(
  options: UnixSocketClientProgramOptions,
): Program<UnixSocketClientMsg, UnixSocketClientState, UnixSocketClientEffect> {
  const { path, randomFn = Math.random } = options
  const reconnect: ReconnectOptions = {
    ...DEFAULT_RECONNECT,
    ...options.reconnect,
  }

  /**
   * Attempt to transition into reconnecting, or give up and disconnect.
   *
   * Wraps the pure `shouldReconnect` decision and builds the unix-socket-specific
   * state/effect tuple. Returns a tuple suitable for spreading into an
   * `update` return.
   */
  function tryReconnect(
    currentAttempt: number,
    reason: DisconnectReason,
    ...extraEffects: UnixSocketClientEffect[]
  ): [UnixSocketClientState, ...UnixSocketClientEffect[]] {
    const d = shouldReconnect(reconnect, currentAttempt, randomFn)
    if (!d.reconnect) {
      const finalReason: DisconnectReason =
        d.cause === "max-attempts-exceeded"
          ? { type: "max-retries-exceeded", attempts: d.attempts }
          : reason
      return [{ status: "disconnected", reason: finalReason }, ...extraEffects]
    }
    return [
      {
        status: "reconnecting",
        attempt: d.attempt,
        nextAttemptMs: d.delayMs,
      },
      ...extraEffects,
      { type: "start-reconnect-timer", delayMs: d.delayMs },
    ]
  }

  return {
    init: [{ status: "disconnected" }],

    update(msg, model): [UnixSocketClientState, ...UnixSocketClientEffect[]] {
      switch (msg.type) {
        // -----------------------------------------------------------------
        // start
        // -----------------------------------------------------------------
        case "start": {
          if (model.status !== "disconnected") return [model]
          return [
            { status: "connecting", attempt: 1 },
            { type: "connect", path, attempt: 1 },
          ]
        }

        // -----------------------------------------------------------------
        // connection-opened
        // -----------------------------------------------------------------
        case "connection-opened": {
          if (model.status !== "connecting") return [model]
          return [
            { status: "connected" },
            { type: "add-channel-and-establish" },
          ]
        }

        // -----------------------------------------------------------------
        // connection-error
        // -----------------------------------------------------------------
        case "connection-error": {
          const reason: DisconnectReason = {
            type: "error",
            error: msg.error,
            ...(msg.errno !== undefined ? { errno: msg.errno } : {}),
          }

          if (model.status === "connecting") {
            return tryReconnect(model.attempt, reason)
          }

          if (model.status === "connected") {
            return tryReconnect(0, reason, { type: "remove-channel" })
          }

          return [model]
        }

        // -----------------------------------------------------------------
        // connection-closed
        // -----------------------------------------------------------------
        case "connection-closed": {
          if (model.status !== "connected") return [model]

          if (!reconnect.enabled) {
            return [
              { status: "disconnected", reason: { type: "closed" } },
              { type: "remove-channel" },
            ]
          }

          return tryReconnect(0, { type: "closed" }, { type: "remove-channel" })
        }

        // -----------------------------------------------------------------
        // reconnect-timer-fired
        // -----------------------------------------------------------------
        case "reconnect-timer-fired": {
          if (model.status !== "reconnecting") return [model]
          return [
            { status: "connecting", attempt: model.attempt },
            { type: "connect", path, attempt: model.attempt },
          ]
        }

        // -----------------------------------------------------------------
        // stop
        // -----------------------------------------------------------------
        case "stop": {
          if (model.status === "disconnected") return [model]

          const effects: UnixSocketClientEffect[] = [
            { type: "cancel-reconnect-timer" },
          ]

          if (model.status === "connected") {
            effects.push(
              { type: "close-connection" },
              { type: "remove-channel" },
            )
          }

          return [
            { status: "disconnected", reason: { type: "intentional" } },
            ...effects,
          ]
        }
      }
    },
  }
}

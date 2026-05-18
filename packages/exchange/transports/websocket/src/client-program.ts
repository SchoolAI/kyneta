// client-program — pure Mealy machine for websocket client connection lifecycle.
//
// The client program encodes every state transition and effect as data.
// The imperative shell (client-transport.ts) interprets effects as I/O.
// Tests assert on data — no sockets, no timing, never flaky.
//
// Algebra: Program<WsClientMsg, WebsocketClientState, WsClientEffect>
// Interpreter: client-transport.ts executeClientEffect()
//
// The websocket client has a 5-state lifecycle with an extra "ready" state
// compared to the unix socket client. The server sends a text "ready" signal
// after the connection opens, and only then does the client create a channel
// and start the establishment handshake.
//
// Race condition: the server may send "ready" before the client's open event
// fires (server-ready while connecting). The program handles this by
// transitioning directly to ready, skipping the connected state.

import type { Program } from "@kyneta/machine"
import type { ReconnectOptions } from "@kyneta/transport"
import { DEFAULT_RECONNECT, shouldReconnect } from "@kyneta/transport"

import type { DisconnectReason, WebsocketClientState } from "./types.js"

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type WsClientMsg =
  | { type: "start" }
  | { type: "socket-opened" }
  | { type: "server-ready" }
  | { type: "socket-closed"; code: number; reason: string }
  | { type: "socket-error"; error: Error }
  | { type: "reconnect-timer-fired" }
  | { type: "stop" }

// ---------------------------------------------------------------------------
// Effects (data — interpreted by the imperative shell)
// ---------------------------------------------------------------------------

export type WsClientEffect =
  | { type: "create-websocket"; attempt: number }
  | { type: "close-websocket" }
  | { type: "add-channel-and-establish" }
  | { type: "remove-channel" }
  | { type: "start-reconnect-timer"; delayMs: number }
  | { type: "cancel-reconnect-timer" }
  | { type: "start-keepalive" }
  | { type: "stop-keepalive" }

// ---------------------------------------------------------------------------
// Program factory
// ---------------------------------------------------------------------------

export interface WsClientProgramOptions {
  reconnect?: Partial<ReconnectOptions>
  /** Source of `[0, 1)` random values for jitter. Default: `Math.random` */
  randomFn?: () => number
}

/**
 * Create the websocket client connection lifecycle program — a pure Mealy machine.
 *
 * The returned `Program<WsClientMsg, WebsocketClientState, WsClientEffect>`
 * encodes every state transition and effect as inspectable data. The imperative
 * shell interprets `WsClientEffect` as actual I/O.
 */
export function createWsClientProgram(
  options: WsClientProgramOptions = {},
): Program<WsClientMsg, WebsocketClientState, WsClientEffect> {
  const { randomFn = Math.random } = options
  const reconnect: ReconnectOptions = {
    ...DEFAULT_RECONNECT,
    ...options.reconnect,
  }

  /**
   * Attempt to transition into reconnecting, or give up and disconnect.
   *
   * Wraps the pure `shouldReconnect` decision and builds the websocket-specific
   * state/effect tuple. Returns a tuple suitable for spreading into an
   * `update` return.
   */
  function tryReconnect(
    currentAttempt: number,
    reason: DisconnectReason,
    ...extraEffects: WsClientEffect[]
  ): [WebsocketClientState, ...WsClientEffect[]] {
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

    update(msg, model): [WebsocketClientState, ...WsClientEffect[]] {
      switch (msg.type) {
        // -----------------------------------------------------------------
        // start
        // -----------------------------------------------------------------
        case "start": {
          if (model.status !== "disconnected") return [model]
          return [
            { status: "connecting", attempt: 1 },
            { type: "create-websocket", attempt: 1 },
          ]
        }

        // -----------------------------------------------------------------
        // socket-opened
        // -----------------------------------------------------------------
        case "socket-opened": {
          if (model.status !== "connecting") return [model]
          return [{ status: "connected" }, { type: "start-keepalive" }]
        }

        // -----------------------------------------------------------------
        // server-ready
        // -----------------------------------------------------------------
        case "server-ready": {
          // Already ready — ignore duplicate
          if (model.status === "ready") return [model]

          // Normal path: connected → ready
          if (model.status === "connected") {
            return [{ status: "ready" }, { type: "add-channel-and-establish" }]
          }

          // Race condition: server sent "ready" before client's open event fired.
          // Skip connected, go directly to ready with both keepalive and channel effects.
          if (model.status === "connecting") {
            return [
              { status: "ready" },
              { type: "start-keepalive" },
              { type: "add-channel-and-establish" },
            ]
          }

          return [model]
        }

        // -----------------------------------------------------------------
        // socket-closed
        // -----------------------------------------------------------------
        case "socket-closed": {
          const reason: DisconnectReason = {
            type: "closed",
            code: msg.code,
            reason: msg.reason,
          }

          if (model.status === "connected") {
            return tryReconnect(0, reason, { type: "stop-keepalive" })
          }

          if (model.status === "ready") {
            return tryReconnect(
              0,
              reason,
              { type: "stop-keepalive" },
              { type: "remove-channel" },
            )
          }

          return [model]
        }

        // -----------------------------------------------------------------
        // socket-error
        // -----------------------------------------------------------------
        case "socket-error": {
          const reason: DisconnectReason = {
            type: "error",
            error: msg.error,
          }

          if (model.status === "connecting") {
            return tryReconnect(model.attempt, reason)
          }

          if (model.status === "connected") {
            return tryReconnect(0, reason, { type: "stop-keepalive" })
          }

          if (model.status === "ready") {
            return tryReconnect(
              0,
              reason,
              { type: "stop-keepalive" },
              { type: "remove-channel" },
            )
          }

          return [model]
        }

        // -----------------------------------------------------------------
        // reconnect-timer-fired
        // -----------------------------------------------------------------
        case "reconnect-timer-fired": {
          if (model.status !== "reconnecting") return [model]
          return [
            { status: "connecting", attempt: model.attempt },
            { type: "create-websocket", attempt: model.attempt },
          ]
        }

        // -----------------------------------------------------------------
        // stop
        // -----------------------------------------------------------------
        case "stop": {
          if (model.status === "disconnected") return [model]

          const effects: WsClientEffect[] = [{ type: "cancel-reconnect-timer" }]

          if (model.status === "connecting") {
            effects.push({ type: "close-websocket" })
          }

          if (model.status === "connected") {
            effects.push(
              { type: "close-websocket" },
              { type: "stop-keepalive" },
            )
          }

          if (model.status === "ready") {
            effects.push(
              { type: "close-websocket" },
              { type: "stop-keepalive" },
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

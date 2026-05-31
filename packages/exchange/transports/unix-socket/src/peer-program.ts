// peer-program — pure Mealy machine for leaderless unix socket topology negotiation.
//
// The peer program encodes the listen-or-connect decision as data. The
// imperative shell (peer-transport.ts) interprets effects by starting and
// stopping the connect/accept drivers — there are no Exchange transports to
// add or remove, so the model is just the current role and the effects name
// the drivers (`start-listener`, `start-connector`, `teardown`).
//
// Algebra: Program<PeerMsg, PeerModel, PeerEffect>
// Interpreter: peer-transport.ts

import type { Program } from "@kyneta/machine"
import type { ReconnectOptions } from "@kyneta/transport"

// ---------------------------------------------------------------------------
// Probe result
// ---------------------------------------------------------------------------

export type ProbeResult = "connected" | "enoent" | "econnrefused" | "eaddrinuse"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type PeerRole = "negotiating" | "listener" | "connector" | "disposed"

export type PeerModel = { role: PeerRole }

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type PeerMsg =
  | { type: "probe-result"; result: ProbeResult }
  | { type: "role-established"; role: "listener" | "connector" }
  | { type: "listen-failed" }
  | { type: "connection-lost" }
  | { type: "dispose" }

// ---------------------------------------------------------------------------
// Effects (data — interpreted by the imperative shell)
// ---------------------------------------------------------------------------

export type PeerEffect =
  | { type: "probe"; path: string }
  | { type: "start-listener"; path: string }
  | {
      type: "start-connector"
      path: string
      reconnect?: Partial<ReconnectOptions>
    }
  | { type: "teardown" }
  | { type: "delay-then-probe"; ms: number; path: string }

// ---------------------------------------------------------------------------
// Program factory
// ---------------------------------------------------------------------------

export interface PeerProgramOptions {
  path: string
  reconnect?: Partial<ReconnectOptions>
  retryDelayMs?: number
}

const DEFAULT_RETRY_DELAY_MS = 200

/**
 * Create the peer negotiation program — a pure Mealy machine.
 *
 * The returned `Program<PeerMsg, PeerModel, PeerEffect>` encodes every state
 * transition and effect as inspectable data. The imperative shell interprets
 * `PeerEffect` by driving the connect/accept drivers.
 */
export function createPeerProgram(
  options: PeerProgramOptions,
): Program<PeerMsg, PeerModel, PeerEffect> {
  const { path, reconnect, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = options

  return {
    init: [{ role: "negotiating" }, { type: "probe", path }],

    update(msg, model): [PeerModel, ...PeerEffect[]] {
      // Disposed state absorbs all messages.
      if (model.role === "disposed") {
        return [model]
      }

      switch (msg.type) {
        case "probe-result": {
          if (model.role !== "negotiating") return [model]

          switch (msg.result) {
            case "connected":
              return [model, { type: "start-connector", path, reconnect }]
            case "enoent":
            case "econnrefused":
              return [model, { type: "start-listener", path }]
            case "eaddrinuse":
              return [
                model,
                { type: "delay-then-probe", ms: retryDelayMs, path },
              ]
          }
          // Unreachable — inner switch is exhaustive over ProbeResult.
          return [model]
        }

        case "role-established":
          return [{ role: msg.role }]

        case "listen-failed":
          return [
            { role: "negotiating" },
            { type: "delay-then-probe", ms: retryDelayMs, path },
          ]

        case "connection-lost": {
          // Only meaningful once a role is held; otherwise a stale signal.
          if (model.role === "negotiating") return [model]
          return [
            { role: "negotiating" },
            { type: "teardown" },
            { type: "probe", path },
          ]
        }

        case "dispose":
          return [{ role: "disposed" }, { type: "teardown" }]
      }
    },
  }
}

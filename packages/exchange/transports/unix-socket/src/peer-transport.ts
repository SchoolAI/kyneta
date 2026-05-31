// peer-transport — leaderless unix socket peer as a single Transport.
//
// ONE `SocketTransport` that swaps its socket MODE in place: the pure
// `createPeerProgram` decides listener-vs-connector; the effect executor
// here realizes that by starting/stopping an internal `ListenerDriver` or
// `ConnectorDriver` and churning its own channels. The Exchange only ever
// sees channel add/remove — it never adds or removes a transport, so this
// module never references `Exchange`.
//
// FC/IS: createPeerProgram (+ the connector's client-program) are the pure
// cores; this class and the drivers are the imperative shells.

import type { ObservableHandle } from "@kyneta/machine"
import { createObservableProgram } from "@kyneta/machine"
import type { ReconnectOptions } from "@kyneta/transport"
import {
  type ConnectorDriver,
  createConnectorDriver,
} from "./connector-driver.js"
import { createListenerDriver, type ListenerDriver } from "./listener-driver.js"
import {
  createPeerProgram,
  type PeerEffect,
  type PeerModel,
  type PeerMsg,
  type PeerRole,
} from "./peer-program.js"
import { probe } from "./probe.js"
import { SocketTransport } from "./socket-transport.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UnixSocketPeerOptions {
  /** Path to the unix socket file. */
  path: string
  /** Reconnect options for connector mode. Always bounded (see below). */
  reconnect?: Partial<ReconnectOptions>
  /** Delay before re-probing on an `EADDRINUSE` race. Default: 200ms. */
  retryDelayMs?: number
}

// ---------------------------------------------------------------------------
// UnixSocketPeerTransport
// ---------------------------------------------------------------------------

/**
 * Leaderless unix socket peer transport.
 *
 * Probes the socket path and becomes the listener (binds) or a connector
 * (connects). If the listener dies, the connector re-negotiates and may
 * become the new listener — all in place, under one stable `transportId`,
 * preserving the Exchange's documents and CRDT state.
 */
export class UnixSocketPeerTransport extends SocketTransport {
  readonly #options: UnixSocketPeerOptions
  #handle: ObservableHandle<PeerMsg, PeerModel> | null = null
  #active: ConnectorDriver | ListenerDriver | null = null

  constructor(options: UnixSocketPeerOptions) {
    super("unix-socket-peer")
    this.#options = options
  }

  /** Current negotiated role. */
  get role(): PeerRole {
    return this.#handle?.getState().role ?? "negotiating"
  }

  /** Observe role transitions. */
  subscribe(fn: (role: PeerRole) => void): () => void {
    if (!this.#handle) return () => {}
    return this.#handle.subscribeToTransitions(t => fn(t.to.role))
  }

  async onStart(): Promise<void> {
    const program = createPeerProgram(this.#options)
    // createObservableProgram fires the init `probe` effect now — we are in
    // "started" state, so the resulting start-* effects may `addChannel`.
    this.#handle = createObservableProgram(program, (effect, dispatch) =>
      this.#execute(effect, dispatch),
    )
  }

  async onStop(): Promise<void> {
    this.#handle?.dispose()
    this.#handle = null
    await this.#teardown()
  }

  // -------------------------------------------------------------------------
  // Effect executor — interprets PeerEffect by driving internal drivers.
  // -------------------------------------------------------------------------
  #execute(effect: PeerEffect, dispatch: (msg: PeerMsg) => void): void {
    switch (effect.type) {
      case "probe":
        void probe(effect.path).then(result =>
          dispatch({ type: "probe-result", result }),
        )
        break

      case "start-listener":
        void (async () => {
          const driver = createListenerDriver({
            path: effect.path,
            sink: this.sink,
          })
          try {
            await driver.start()
            this.#active = driver
            dispatch({ type: "role-established", role: "listener" })
          } catch {
            // EADDRINUSE etc. — someone else won the bind; re-probe.
            dispatch({ type: "listen-failed" })
          }
        })()
        break

      case "start-connector": {
        const driver = createConnectorDriver({
          path: effect.path,
          // Leaderless recovery is RE-NEGOTIATION, not reconnection: on
          // disconnect the connector re-probes, which either finds the new
          // listener (→ reconnect) or binds the socket itself (→ become the
          // listener). So the connector does not cling to a dead listener —
          // it gives up immediately and lets the negotiator heal. A caller
          // may still opt into bounded reconnect via `reconnect`.
          reconnect: { enabled: false, ...effect.reconnect },
          sink: this.sink,
          onExhausted: () => dispatch({ type: "connection-lost" }),
        })
        this.#active = driver
        driver.start()
        dispatch({ type: "role-established", role: "connector" })
        break
      }

      case "teardown":
        void this.#teardown()
        break

      case "delay-then-probe":
        setTimeout(() => {
          void probe(effect.path).then(result =>
            dispatch({ type: "probe-result", result }),
          )
        }, effect.ms)
        break
    }
  }

  // Stop whatever driver is active (closes its sockets + drops its channels).
  async #teardown(): Promise<void> {
    const active = this.#active
    this.#active = null
    await active?.stop()
  }
}

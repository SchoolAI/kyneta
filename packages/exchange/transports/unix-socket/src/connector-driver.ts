// connector-driver — one outbound connection with bounded reconnect.
//
// Imperative shell over the pure `createUnixSocketClientProgram` (the
// reconnect core). Differs from the listener only in how it acquires its
// socket (connect + backoff) and that it initiates the establish handshake.
// When reconnect is exhausted it fires `onExhausted` so the owner (a fixed
// client, or the leaderless peer) can react — the peer re-negotiates.

import type { ObservableHandle } from "@kyneta/machine"
import { createObservableProgram } from "@kyneta/machine"
import type { ConnectedChannel, ReconnectOptions } from "@kyneta/transport"
import { attachSocket } from "./attach-socket.js"
import {
  createUnixSocketClientProgram,
  type UnixSocketClientEffect,
  type UnixSocketClientMsg,
} from "./client-program.js"
import { connect } from "./connect.js"
import type { UnixSocketConnection } from "./connection.js"
import type { ChannelSink } from "./socket-transport.js"
import type { UnixSocket, UnixSocketClientState } from "./types.js"

export interface ConnectorDriver {
  start(): void
  stop(): Promise<void>
  readonly connected: boolean
  getState(): UnixSocketClientState
  waitForStatus(
    status: UnixSocketClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<UnixSocketClientState>
}

export interface ConnectorDriverOptions {
  path: string
  reconnect?: Partial<ReconnectOptions>
  sink: ChannelSink
  /** Reconnect gave up (unintentional disconnect) → owner should re-negotiate. */
  onExhausted?: () => void
}

export function createConnectorDriver(
  opts: ConnectorDriverOptions,
): ConnectorDriver {
  const { path, reconnect, sink, onExhausted } = opts

  let channel: ConnectedChannel | undefined
  let connection: UnixSocketConnection | undefined
  let pendingSocket: UnixSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const program = createUnixSocketClientProgram({ path, reconnect })
  const handle: ObservableHandle<UnixSocketClientMsg, UnixSocketClientState> =
    createObservableProgram(program, (effect, dispatch) =>
      execute(effect, dispatch),
    )

  // Fire `onExhausted` once per give-up. `stop()` also lands in
  // "disconnected" but with `reason: intentional` — skip that path.
  handle.subscribeToTransitions(t => {
    if (t.to.status === "disconnected" && t.to.reason?.type !== "intentional") {
      onExhausted?.()
    }
  })

  function execute(
    effect: UnixSocketClientEffect,
    dispatch: (msg: UnixSocketClientMsg) => void,
  ): void {
    switch (effect.type) {
      case "connect":
        void doConnect(effect.path, dispatch)
        break

      case "close-connection":
        connection?.close()
        connection = undefined
        break

      case "add-channel-and-establish": {
        const socket = pendingSocket
        pendingSocket = undefined
        if (!socket) return
        const attached = attachSocket(socket, sink, { establish: true })
        channel = attached.channel
        connection = attached.connection
        break
      }

      case "remove-channel":
        if (channel) {
          tryRemoveChannel(channel.channelId)
          channel = undefined
        }
        connection = undefined
        break

      case "start-reconnect-timer":
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined
          dispatch({ type: "reconnect-timer-fired" })
        }, effect.delayMs)
        break

      case "cancel-reconnect-timer":
        if (reconnectTimer !== undefined) {
          clearTimeout(reconnectTimer)
          reconnectTimer = undefined
        }
        break
    }
  }

  async function doConnect(
    p: string,
    dispatch: (msg: UnixSocketClientMsg) => void,
  ): Promise<void> {
    try {
      const socket = await connect(p)
      pendingSocket = socket
      socket.onClose(() => dispatch({ type: "connection-closed" }))
      socket.onError((error: Error) => {
        const errno = (error as NodeJS.ErrnoException).code
        dispatch({ type: "connection-error", error, errno })
      })
      dispatch({ type: "connection-opened" })
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      const errno = (error as NodeJS.ErrnoException).code
      dispatch({ type: "connection-error", error: wrapped, errno })
    }
  }

  // removeChannel throws outside "started"; a late teardown may race a close.
  function tryRemoveChannel(channelId: number): void {
    try {
      sink.removeChannel(channelId)
    } catch {
      // transport already stopping — nothing to remove
    }
  }

  return {
    start() {
      handle.dispatch({ type: "start" })
    },
    async stop() {
      handle.dispatch({ type: "stop" })
      handle.dispose()
      // The program's `stop` removes the channel + closes the connection when
      // connected; cover the mid-connect case where there is no channel yet.
      connection?.close()
      connection = undefined
      if (channel) {
        tryRemoveChannel(channel.channelId)
        channel = undefined
      }
    },
    get connected() {
      return handle.getState().status === "connected"
    },
    getState() {
      return handle.getState()
    },
    waitForStatus(status, options) {
      return handle.waitForStatus(status, options)
    },
  }
}

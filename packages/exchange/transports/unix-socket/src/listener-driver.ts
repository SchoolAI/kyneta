// listener-driver — bound server socket, N inbound channels.
//
// Imperative shell that binds the socket path, accepts connections, and turns
// each into a channel via the shared `attachSocket`. Differs from the
// connector only in socket acquisition (listen/accept, no reconnect, no
// establish-initiation) and in owning the socket-file lifecycle (stale
// cleanup on start, unlink on stop).

import type { ConnectedChannel } from "@kyneta/transport"
import { attachSocket } from "./attach-socket.js"
import type { UnixSocketConnection } from "./connection.js"
import { listen, type UnixSocketListener } from "./listen.js"
import type { ChannelSink } from "./socket-transport.js"
import type { UnixSocket } from "./types.js"

export interface ListenerDriver {
  /** Bind and start accepting. Resolves once bound; rejects on bind failure. */
  start(): Promise<void>
  /** Close every connection, stop the listener, and unlink the socket file. */
  stop(): Promise<void>
  readonly connectionCount: number
}

export interface ListenerDriverOptions {
  path: string
  /** Remove a stale socket file before binding. Default: true. */
  cleanup?: boolean
  sink: ChannelSink
}

export function createListenerDriver(
  opts: ListenerDriverOptions,
): ListenerDriver {
  const { path, cleanup = true, sink } = opts
  let listener: UnixSocketListener | null = null
  // channelId → live connection, so stop() can close sockets + drop channels.
  const live = new Map<
    number,
    { channel: ConnectedChannel; connection: UnixSocketConnection }
  >()

  function handleConnection(socket: UnixSocket): void {
    const attached = attachSocket(socket, sink, { establish: false })
    const id = attached.channel.channelId
    live.set(id, attached)
    socket.onClose(() => unregister(id))
    socket.onError(() => unregister(id))
  }

  function unregister(channelId: number): void {
    const entry = live.get(channelId)
    if (!entry) return
    live.delete(channelId)
    entry.connection.close()
    try {
      sink.removeChannel(channelId)
    } catch {
      // transport already stopping — channel gone
    }
  }

  return {
    async start() {
      if (cleanup) await cleanupStaleSocket(path)
      listener = await listen(path, handleConnection)
    },
    async stop() {
      for (const id of [...live.keys()]) unregister(id)
      if (listener) {
        listener.stop()
        listener = null
        await unlinkSocket(path)
      }
    },
    get connectionCount() {
      return live.size
    },
  }
}

// ---------------------------------------------------------------------------
// Socket-file lifecycle
// ---------------------------------------------------------------------------

/**
 * Remove a stale socket file if it exists. A previous crash can leave the
 * file behind; if it is actively in use the later `listen` fails with
 * `EADDRINUSE`, which is the correct signal to the negotiator.
 */
async function cleanupStaleSocket(path: string): Promise<void> {
  try {
    const { unlink, stat } = await import("node:fs/promises")
    const stats = await stat(path)
    if (stats.isSocket()) await unlink(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function unlinkSocket(path: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises")
    await unlink(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[listener-driver] Failed to unlink socket file ${path}:`,
        error,
      )
    }
  }
}

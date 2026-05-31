// attach-socket — the one place a raw socket becomes a live channel.
//
// Shared by both drivers. The only role-dependent knob is `establish`:
// the connector initiates the establish handshake (the client side does),
// the listener does not (its channel is established when it processes the
// connector's inbound establish message).
//
// `attachSocket` does NOT wire socket close/error — the driver owns that,
// because the semantics differ (the listener forgets a departed peer; the
// connector hands closure to its reconnect program).

import type { ConnectedChannel } from "@kyneta/transport"
import { UnixSocketConnection } from "./connection.js"
import type { ChannelSink } from "./socket-transport.js"
import type { UnixSocket } from "./types.js"

/**
 * Wrap a freshly-obtained socket as a live channel and start processing.
 *
 * @returns the new channel and its connection. The caller wires
 *   `socket.onClose` / `socket.onError` to its own teardown.
 */
export function attachSocket(
  socket: UnixSocket,
  sink: ChannelSink,
  opts: { establish: boolean },
): { channel: ConnectedChannel; connection: UnixSocketConnection } {
  const connection = new UnixSocketConnection(socket)
  // generate(connection) binds the channel's send straight to this connection.
  const channel = sink.addChannel(connection)
  connection.setChannel(channel)
  connection.start()
  if (opts.establish) {
    sink.establishChannel(channel.channelId)
  }
  return { channel, connection }
}

// socket-transport — shared base for every unix-socket Transport.
//
// All three roles (client, server, leaderless peer) are `Transport`s whose
// per-channel context (`G`) is the `UnixSocketConnection` itself: a channel's
// `send`/`stop` bind directly to its connection, so there is no
// `peerId → connection` map and no routing lookup anywhere.
//
// The base also lends its protected channel operations to the connect/accept
// drivers as a small `ChannelSink`, so a driver can add/remove/establish
// channels without being a `Transport` of its own.

import type {
  ChannelId,
  ChannelMsg,
  ConnectedChannel,
  GeneratedChannel,
  TransportType,
} from "@kyneta/transport"
import { Transport } from "@kyneta/transport"
import type { UnixSocketConnection } from "./connection.js"

/**
 * The channel-lifecycle operations a `SocketTransport` lends to a driver.
 *
 * `addChannel` takes the connection itself as the channel's generate-context,
 * so the resulting channel's `send` routes straight to it.
 */
export interface ChannelSink {
  addChannel(connection: UnixSocketConnection): ConnectedChannel
  removeChannel(channelId: ChannelId): void
  establishChannel(channelId: ChannelId): void
}

/**
 * Base class for the unix-socket transports.
 *
 * Implements the one `generate` every role shares (bind send/stop to the
 * connection) and exposes a `sink` bound to the protected channel ops. The
 * channel ops still enforce the `"started"`-only lifecycle from `Transport`.
 */
export abstract class SocketTransport extends Transport<UnixSocketConnection> {
  /** Channel ops bound to this transport, handed to the active driver. */
  protected readonly sink: ChannelSink

  constructor(transportType: TransportType) {
    super({ transportType })
    this.sink = {
      addChannel: connection => this.addChannel(connection),
      removeChannel: channelId => this.removeChannel(channelId),
      establishChannel: channelId => this.establishChannel(channelId),
    }
  }

  protected generate(connection: UnixSocketConnection): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: (msg: ChannelMsg) => connection.send(msg),
      stop: () => connection.close(),
    }
  }
}

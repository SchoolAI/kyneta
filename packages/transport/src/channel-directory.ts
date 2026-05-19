// channel-directory — channel tracking by id.
//
// The directory does not mint channelIds. Callers supply them (see
// `TransportContext.mintChannelId`) so that one `Synchronizer` owning
// multiple transports shares a single id namespace — without this,
// independent per-directory counters would collide and the session
// model's `Map<ChannelId, ChannelEntry>` would silently overwrite
// entries.

import type {
  Channel,
  ConnectedChannel,
  GenerateFn,
  ReceiveFn,
} from "./channel.js"
import type { ChannelId } from "./types.js"

export class ChannelDirectory<G> {
  private readonly channels: Map<ChannelId, Channel> = new Map()

  constructor(readonly generate: GenerateFn<G>) {}

  *[Symbol.iterator](): IterableIterator<Channel> {
    yield* this.channels.values()
  }

  has(channelId: ChannelId): boolean {
    return this.channels.has(channelId)
  }

  get(channelId: ChannelId): Channel | undefined {
    return this.channels.get(channelId)
  }

  get size(): number {
    return this.channels.size
  }

  /**
   * Create a ConnectedChannel from the adapter's generate function.
   *
   * The channelId is supplied by the caller (typically `Transport.addChannel`
   * via `TransportContext.mintChannelId`); the directory does not invent it.
   * The channel starts in "connected" state — it must complete the
   * establish handshake to become "established".
   */
  create(
    channelId: ChannelId,
    context: G,
    onReceive: ReceiveFn,
  ): ConnectedChannel {
    const generatedChannel = this.generate(context)

    const channel: ConnectedChannel = {
      ...generatedChannel,
      type: "connected",
      channelId,
      onReceive,
    }

    this.channels.set(channelId, channel)

    return channel
  }

  /**
   * Update a channel in-place (e.g. after establishment).
   */
  set(channelId: ChannelId, channel: Channel): void {
    this.channels.set(channelId, channel)
  }

  remove(channelId: ChannelId): Channel | undefined {
    const channel = this.channels.get(channelId)
    if (!channel) return undefined

    this.channels.delete(channelId)
    return channel
  }

  reset(): void {
    this.channels.clear()
  }
}

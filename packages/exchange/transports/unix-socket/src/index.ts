// @kyneta/unix-socket-transport — unix domain socket transport.

// Client transport + factory
export {
  createUnixSocketClient,
  type DisconnectReason,
  type UnixSocketClientOptions,
  type UnixSocketClientState,
  UnixSocketClientTransport,
} from "./client-transport.js"
// Platform-abstracted connect/listen
export { connect } from "./connect.js"
// Connection
export { UnixSocketConnection } from "./connection.js"
export { listen } from "./listen.js"
// Peer — leaderless topology negotiation
export {
  createUnixSocketPeer,
  type UnixSocketPeerHandle,
  type UnixSocketPeerOptions,
} from "./peer.js"
// Peer program — pure Mealy machine for negotiation logic
export {
  createPeerProgram,
  type PeerEffect,
  type PeerModel,
  type PeerMsg,
  type PeerProgramOptions,
  type PeerRole,
  type ProbeResult,
} from "./peer-program.js"
// Peer transport (advanced — usually constructed via createUnixSocketPeer)
export { UnixSocketPeerTransport } from "./peer-transport.js"
// Server transport
export {
  type OnConnectionCallback,
  type UnixSocketListener,
  type UnixSocketServerOptions,
  UnixSocketServerTransport,
} from "./server-transport.js"
// Shared types + wrappers
export type {
  BunSocketHandlers,
  BunUnixSocketLike,
  NodeUnixSocketLike,
  UnixSocket,
} from "./types.js"
export { wrapBunUnixSocket, wrapNodeUnixSocket } from "./types.js"

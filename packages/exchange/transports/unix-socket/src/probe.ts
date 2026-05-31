// probe — classify a socket path by attempting a short connection.
//
// The result drives the leaderless negotiator's listen-or-connect decision.
// A probe opens and immediately ends a connection; on a listener this shows
// up as a brief inbound accept that never sends `establish` (so it produces
// an addChannel/removeChannel pair with no peer-level event).

import { connect } from "./connect.js"
import type { ProbeResult } from "./peer-program.js"

export async function probe(path: string): Promise<ProbeResult> {
  try {
    const socket = await connect(path)
    socket.end()
    return "connected"
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case "ENOENT":
        return "enoent"
      case "ECONNREFUSED":
        return "econnrefused"
      case "EADDRINUSE":
        return "eaddrinuse"
      default:
        // Unknown error — treat as "no server" → try to listen.
        return "enoent"
    }
  }
}

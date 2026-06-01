// connectivity — unit tests for the pure deriveConnectivity classifier.
// No Synchronizer, no transports — just the classification rule.

import { describe, expect, it } from "vitest"
import { deriveConnectivity } from "../synchronizer.js"

describe("deriveConnectivity", () => {
  it("is offline when no transports are configured", () => {
    expect(deriveConnectivity({ establishedPeers: 0, transportCount: 0 })).toBe(
      "offline",
    )
  })

  it("is connecting with transports but no established peer", () => {
    expect(deriveConnectivity({ establishedPeers: 0, transportCount: 2 })).toBe(
      "connecting",
    )
  })

  it("is online with at least one established peer", () => {
    expect(deriveConnectivity({ establishedPeers: 1, transportCount: 2 })).toBe(
      "online",
    )
  })

  it("prioritizes online even if (hypothetically) transportCount is 0", () => {
    // establishedPeers > 0 wins regardless — an established peer implies a
    // live channel.
    expect(deriveConnectivity({ establishedPeers: 3, transportCount: 0 })).toBe(
      "online",
    )
  })
})

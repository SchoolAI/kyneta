// peer-program.test — deterministic tests for the peer negotiation state machine.
//
// Every state × event combination is tested. Pure data in, pure data out —
// no sockets, no timing, never flaky. The model is just `{ role }`; effects
// name the drivers (`start-listener`/`start-connector`/`teardown`).

import { describe, expect, it } from "vitest"
import {
  createPeerProgram,
  type PeerModel,
  type PeerMsg,
} from "../peer-program.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PATH = "/tmp/test.sock"
const RETRY_MS = 200

function setup(retryDelayMs = RETRY_MS) {
  const program = createPeerProgram({ path: PATH, retryDelayMs })
  return { program, update: program.update }
}

const negotiating: PeerModel = { role: "negotiating" }
const listener: PeerModel = { role: "listener" }
const connector: PeerModel = { role: "connector" }
const disposed: PeerModel = { role: "disposed" }

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

describe("peer program — init", () => {
  it("starts negotiating with a probe effect", () => {
    const { program } = setup()
    const [model, ...effects] = program.init

    expect(model).toEqual({ role: "negotiating" })
    expect(effects).toEqual([{ type: "probe", path: PATH }])
  })
})

// ---------------------------------------------------------------------------
// Probe results (while negotiating)
// ---------------------------------------------------------------------------

describe("peer program — probe-result", () => {
  it('"connected" → start-connector', () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "connected" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "start-connector", path: PATH, reconnect: undefined },
    ])
  })

  it('"enoent" → start-listener', () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "enoent" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([{ type: "start-listener", path: PATH }])
  })

  it('"econnrefused" → start-listener', () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "econnrefused" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([{ type: "start-listener", path: PATH }])
  })

  it('"eaddrinuse" → delay-then-probe', () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "eaddrinuse" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "delay-then-probe", ms: RETRY_MS, path: PATH },
    ])
  })

  it("probe-result while listener → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "connected" },
      listener,
    )
    expect(model).toEqual(listener)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Role established
// ---------------------------------------------------------------------------

describe("peer program — role-established", () => {
  it("as listener → role is listener", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "role-established", role: "listener" },
      negotiating,
    )
    expect(model).toEqual({ role: "listener" })
    expect(effects).toEqual([])
  })

  it("as connector → role is connector", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "role-established", role: "connector" },
      negotiating,
    )
    expect(model).toEqual({ role: "connector" })
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Listen failed
// ---------------------------------------------------------------------------

describe("peer program — listen-failed", () => {
  it("→ negotiating + delay-then-probe", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "listen-failed" }, negotiating)
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "delay-then-probe", ms: RETRY_MS, path: PATH },
    ])
  })
})

// ---------------------------------------------------------------------------
// Connection lost (healing) — the bounded-reconnect-then-renegotiate trigger
// ---------------------------------------------------------------------------

describe("peer program — connection-lost", () => {
  it("while connector → teardown + re-probe (heal)", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "connection-lost" }, connector)
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "teardown" },
      { type: "probe", path: PATH },
    ])
  })

  it("while listener → teardown + re-probe", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "connection-lost" }, listener)
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "teardown" },
      { type: "probe", path: PATH },
    ])
  })

  it("while negotiating → no change (stale signal)", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "connection-lost" }, negotiating)
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("peer program — dispose", () => {
  it("→ disposed + teardown (idempotent: executor no-ops if nothing active)", () => {
    const { update } = setup()
    for (const from of [negotiating, listener, connector]) {
      const [model, ...effects] = update({ type: "dispose" }, from)
      expect(model).toEqual(disposed)
      expect(effects).toEqual([{ type: "teardown" }])
    }
  })
})

// ---------------------------------------------------------------------------
// Disposed absorbs all messages
// ---------------------------------------------------------------------------

describe("peer program — disposed state absorbs all", () => {
  const messages: PeerMsg[] = [
    { type: "probe-result", result: "connected" },
    { type: "role-established", role: "listener" },
    { type: "listen-failed" },
    { type: "connection-lost" },
    { type: "dispose" },
  ]

  for (const msg of messages) {
    it(`${msg.type} while disposed → no change`, () => {
      const { update } = setup()
      const [model, ...effects] = update(msg, disposed)
      expect(model).toEqual(disposed)
      expect(effects).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// Multi-step lifecycle sequence
// ---------------------------------------------------------------------------

describe("peer program — lifecycle sequence", () => {
  it("init → probe → listener → lost → re-probe → connector → dispose", () => {
    const { program, update } = setup()

    // 1. Init: negotiating + probe
    const [m0, ...fx0] = program.init
    expect(m0.role).toBe("negotiating")
    expect(fx0).toEqual([{ type: "probe", path: PATH }])

    // 2. Probe finds no socket → start listener
    const [m1, ...fx1] = update({ type: "probe-result", result: "enoent" }, m0)
    expect(fx1[0]).toEqual({ type: "start-listener", path: PATH })

    // 3. Listener established
    const [m2, ...fx2] = update(
      { type: "role-established", role: "listener" },
      m1,
    )
    expect(m2).toEqual({ role: "listener" })
    expect(fx2).toEqual([])

    // 4. Listener dies → teardown + re-probe
    const [m3, ...fx3] = update({ type: "connection-lost" }, m2)
    expect(m3).toEqual({ role: "negotiating" })
    expect(fx3).toEqual([{ type: "teardown" }, { type: "probe", path: PATH }])

    // 5. Re-probe finds a new listener → become connector
    const [m4, ...fx4] = update(
      { type: "probe-result", result: "connected" },
      m3,
    )
    expect(fx4[0]).toMatchObject({ type: "start-connector" })

    // 6. Connector established
    const [m5, ...fx5] = update(
      { type: "role-established", role: "connector" },
      m4,
    )
    expect(m5).toEqual({ role: "connector" })
    expect(fx5).toEqual([])

    // 7. Dispose while connector → teardown
    const [m6, ...fx6] = update({ type: "dispose" }, m5)
    expect(m6).toEqual({ role: "disposed" })
    expect(fx6).toEqual([{ type: "teardown" }])

    // 8. Further messages are absorbed
    const [m7, ...fx7] = update(
      { type: "probe-result", result: "connected" },
      m6,
    )
    expect(m7).toEqual(m6)
    expect(fx7).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Reconnect options pass-through
// ---------------------------------------------------------------------------

describe("peer program — reconnect options", () => {
  it("passes reconnect options to start-connector effect", () => {
    const reconnect = { maxAttempts: 3, baseDelay: 50, maxDelay: 100 }
    const program = createPeerProgram({ path: PATH, reconnect })
    const [, ...effects] = program.update(
      { type: "probe-result", result: "connected" },
      negotiating,
    )
    expect(effects).toEqual([
      { type: "start-connector", path: PATH, reconnect },
    ])
  })
})

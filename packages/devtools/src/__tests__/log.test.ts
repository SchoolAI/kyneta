// log — pure `formatObservation` render + the `logObservations` shell
// (escalation + detach), driven by a fake bus (no Exchange, no console noise).

import type { ObsEvent } from "@kyneta/exchange"
import { describe, expect, it } from "vitest"
import { formatObservation, logObservations } from "../log.js"

const diagnostic: ObsEvent = {
  v: 1,
  seq: 5,
  t: 0,
  peerId: "alice",
  layer: "diagnostic",
  kind: "diagnostic",
  code: "schema-hash-mismatch",
  severity: "error",
  peer: "bob",
  docId: "clash",
  local: "h1",
  remote: "h2",
  message: "hash mismatch",
} as ObsEvent

const localChangeset: ObsEvent = {
  v: 1,
  seq: 3,
  t: 0,
  peerId: "alice",
  layer: "doc",
  kind: "changeset",
  docId: "d",
  replay: false,
  ops: [
    { type: "text", path: "/title" },
    { type: "replace", path: "/items/0/done" },
  ],
} as ObsEvent

describe("formatObservation (pure)", () => {
  it("renders a diagnostic's structured cause: severity + code + local/remote", () => {
    const line = formatObservation(diagnostic)
    expect(line).toContain("alice:5") // peerId:seq correlation key
    expect(line).toContain("error") // severity
    expect(line).toContain("schema-hash-mismatch") // code
    expect(line).toContain("h1") // local
    expect(line).toContain("h2") // remote
  })

  it("renders a doc changeset with [local] provenance + op count", () => {
    const line = formatObservation(localChangeset)
    expect(line).toContain("[local]")
    expect(line).toContain("2 ops")
  })

  it("renders [replay] + singular op count for a replayed changeset", () => {
    const line = formatObservation({
      ...localChangeset,
      replay: true,
      ops: [{ type: "text", path: "/title" }],
    } as ObsEvent)
    expect(line).toContain("[replay]")
    expect(line).toContain("1 op")
    expect(line).not.toContain("1 ops")
  })

  it("is ANSI-free by default and colorized on request", () => {
    expect(formatObservation(diagnostic)).not.toContain("\x1b")
    expect(formatObservation(diagnostic, { color: true })).toContain("\x1b")
  })
})

function fakeBus(): {
  observe: (sink: (e: ObsEvent) => void) => () => void
  emit: (e: ObsEvent) => void
} {
  const sinks = new Set<(e: ObsEvent) => void>()
  return {
    observe(sink) {
      sinks.add(sink)
      return () => sinks.delete(sink)
    },
    emit(e) {
      for (const sink of sinks) sink(e)
    },
  }
}

describe("logObservations (shell)", () => {
  it("prints each event, escalates only error diagnostics, and detaches", () => {
    const bus = fakeBus()
    const lines: string[] = []
    const escalated: ObsEvent[] = []
    const off = logObservations(
      { observe: bus.observe },
      { write: l => lines.push(l), onDiagnostic: e => escalated.push(e) },
    )

    bus.emit({
      v: 1,
      seq: 0,
      t: 0,
      peerId: "a",
      layer: "engine",
      kind: "transition",
      program: "sync",
      summary: "x",
    } as ObsEvent)
    bus.emit(diagnostic) // error severity → escalates
    bus.emit({
      ...diagnostic,
      seq: 6,
      severity: "warning",
      code: "protocol-skew",
    } as ObsEvent) // warning → prints, does not escalate

    expect(lines).toHaveLength(3)
    expect(escalated).toHaveLength(1)
    expect(escalated[0]?.seq).toBe(5)

    off()
    bus.emit({ ...diagnostic, seq: 7 } as ObsEvent)
    expect(lines).toHaveLength(3) // no emission after detach
    expect(escalated).toHaveLength(1)
  })
})

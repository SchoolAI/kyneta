// pipeline — imperative shell wrapping the pure pipeline-core step functions.
//
// The Pipeline class owns mutable state (alias table, reassembler, frame ID
// counter) and delegates all logic to sendStep / receiveStep. It also
// routes errors through the onError callback for observability.
//
// Usage:
//   const p = new Pipeline({ send: "binary" })
//   const outputs = p.send(msg)     // → Result<Uint8Array, WireError>[]
//   const inputs  = p.receive(data) // → Result<ChannelMsg, WireError>[]
//   p.dispose()

import {
  BINARY_CODEC,
  Reassembler,
  type Result,
  TEXT_CODEC,
  type WireCodec,
  type WireError,
} from "@kyneta/wire"
import { emptyAliasState } from "./alias-table.js"
import type { ChannelMsg } from "./messages.js"
import {
  type Encoding,
  type PayloadOf,
  type PipelineState,
  type ResolvedOpts,
  receiveStep,
  sendStep,
} from "./pipeline-core.js"

const CODECS = { binary: BINARY_CODEC, text: TEXT_CODEC } as const

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * A per-frame trace event, emitted by `WireOpts.onFrame` for debugging and
 * tracing. `seq` is the per-direction message id stamped in the frame header;
 * a sender's send-`seq` equals the receiver's receive-`seq` for the same
 * message, so the two ends can name the same exchange in their logs.
 *
 * On `send`, fires once per emitted wire piece — for a fragmented message
 * that is N events sharing one `seq`, each with its `index`/`total`. On
 * `receive`, fires once per fully-decoded inbound message (`kind: "complete"`);
 * individual inbound fragments are not surfaced here.
 */
export interface FrameTrace {
  readonly dir: "send" | "receive"
  readonly seq: number
  readonly kind: "complete" | "fragment"
  /** Fragment position (send-side fragments only). */
  readonly index?: number
  /** Fragment count (send-side fragments only). */
  readonly total?: number
  /** Wire-piece size in substrate units (bytes for binary, chars for text). */
  readonly size: number
}

export interface WireOpts {
  readonly threshold?: number
  readonly reassemblyTimeoutMs?: number
  readonly reassemblyMaxConcurrentFrames?: number
  readonly reassemblyMaxTotalSize?: number
  readonly onError?: (e: WireError, dir: "send" | "receive") => void
  /** Opt-in per-frame trace hook. Zero cost when unset. */
  readonly onFrame?: (ev: FrameTrace) => void
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class Pipeline<S extends Encoding, R extends Encoding = S> {
  #sendCodec: WireCodec<PayloadOf<S>>
  #recvCodec: WireCodec<PayloadOf<R>>
  #opts: ResolvedOpts
  #wireOpts: WireOpts
  #state: PipelineState<PayloadOf<R>>
  #disposed = false

  constructor(config: { send: S; receive?: R; opts?: WireOpts }) {
    const recvEncoding = (config.receive ?? config.send) as R
    // Double-cast required: CODECS[config.send] yields WireCodec<Uint8Array<ArrayBuffer>> |
    // WireCodec<string>. TS can't narrow this union through the generic string-literal index
    // to WireCodec<PayloadOf<S>>. The types align structurally — BINARY_CODEC is
    // WireCodec<Uint8Array<ArrayBuffer>> = WireCodec<PayloadOf<"binary">>, TEXT_CODEC is
    // WireCodec<string> = WireCodec<PayloadOf<"text">> — but the proof requires `unknown`.
    this.#sendCodec = CODECS[config.send] as unknown as WireCodec<PayloadOf<S>>
    this.#recvCodec = CODECS[recvEncoding] as unknown as WireCodec<PayloadOf<R>>
    this.#wireOpts = config.opts ?? {}
    this.#opts = {
      threshold: this.#wireOpts.threshold ?? 0,
      onError: this.#wireOpts.onError,
    }
    this.#state = this.#buildState()
  }

  send(msg: ChannelMsg): readonly Result<PayloadOf<S>, WireError>[] {
    if (this.#disposed) throw new Error("Pipeline disposed")
    const result = sendStep(
      this.#state as PipelineState<unknown>,
      this.#sendCodec,
      this.#opts,
      msg,
    )
    // Update state (aliasState may have changed; nextSeq advanced this send)
    this.#state = {
      ...this.#state,
      aliasState: result.state.aliasState,
      nextSeq: result.state.nextSeq,
    }
    // Route errors through onError
    for (const r of result.outputs) {
      if (!r.ok && this.#opts.onError) {
        this.#opts.onError(r.error, "send")
      }
    }
    // Per-frame traces — one per emitted piece (N for a fragmented message).
    const onFrame = this.#wireOpts.onFrame
    const trace = result.trace
    if (onFrame && trace) {
      const pieces: PayloadOf<S>[] = []
      for (const r of result.outputs) if (r.ok) pieces.push(r.value)
      const total = pieces.length
      pieces.forEach((piece, index) => {
        onFrame({
          dir: "send",
          seq: trace.seq,
          kind: trace.kind,
          index: trace.kind === "fragment" ? index : undefined,
          total: trace.kind === "fragment" ? total : undefined,
          size: this.#sendCodec.sizeOf(piece),
        })
      })
    }
    return result.outputs
  }

  receive(piece: PayloadOf<R>): readonly Result<ChannelMsg, WireError>[] {
    if (this.#disposed) throw new Error("Pipeline disposed")
    const result = receiveStep(this.#state, this.#recvCodec, this.#opts, piece)
    this.#state = result.state
    // Route errors through onError
    for (const r of result.inputs) {
      if (!r.ok && this.#opts.onError) {
        this.#opts.onError(r.error, "receive")
      }
    }
    // Per-frame trace — fires once per fully-decoded inbound message.
    const onFrame = this.#wireOpts.onFrame
    const trace = result.trace
    if (onFrame && trace) {
      onFrame({
        dir: "receive",
        seq: trace.seq,
        kind: trace.kind,
        size: this.#recvCodec.sizeOf(piece),
      })
    }
    return result.inputs
  }

  reset(): void {
    if (this.#disposed) throw new Error("Pipeline disposed")
    this.#state.reassembler.reset()
    this.#state = {
      aliasState: emptyAliasState(),
      reassembler: this.#state.reassembler,
      nextSeq: 1,
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#state.reassembler.dispose()
  }

  #buildState(): PipelineState<PayloadOf<R>> {
    const onError = this.#opts.onError
    return {
      aliasState: emptyAliasState(),
      reassembler: new Reassembler(this.#recvCodec, {
        timeoutMs: this.#wireOpts.reassemblyTimeoutMs,
        maxConcurrentFrames: this.#wireOpts.reassemblyMaxConcurrentFrames,
        maxTotalSize: this.#wireOpts.reassemblyMaxTotalSize,
        onTimeout: onError
          ? seq =>
              onError(
                {
                  code: "reassembly-timeout",
                  detail: { seq, partialCount: 0 },
                },
                "receive",
              )
          : undefined,
        onEvicted: onError
          ? seq =>
              onError(
                { code: "reassembly-evicted", detail: { seq } },
                "receive",
              )
          : undefined,
      }),
      nextSeq: 1,
    }
  }
}

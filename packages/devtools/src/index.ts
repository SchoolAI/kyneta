// @kyneta/devtools — a reactive world model over the Kyneta observation
// (ObsEvent) stream, composed from @kyneta/index.
//
// The only bespoke logic is the pure `classify`; the world model is a record
// of live @kyneta/index views (Collections + cross-peer docId groupings),
// each a [CHANGEFEED]. Wire it to an Exchange with `attach`, or feed a merged
// multi-peer stream via `model.ingest`. Experimental — tracks ObsEvent v1.

export { classify, type Routing, type WorldStream } from "./classify.js"
export type {
  DiagnosticEntry,
  DocView,
  PeerView,
  SyncEntry,
  WorldModel,
} from "./model.js"
export {
  type DocViewComposite,
  docActivity,
  docView,
  syncFor,
  timeline,
} from "./select.js"
export {
  attach,
  type CreateWorldModelOptions,
  createWorldModel,
  type ObservableExchange,
  type WorldModelHandle,
} from "./world.js"

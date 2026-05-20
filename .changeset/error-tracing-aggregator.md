---
'@endo/marshal': minor
'@endo/captp': minor
'@endo/daemon': minor
---

Add an error-tracing facility that correlates a caught error in a CLI or chat client back to the worker and emission site that produced it.

`@endo/marshal` gains a `marshalLoadError(err, errorId)` option on `makeMarshal`.
The hook fires when an inbound smallcaps error is decoded, receiving the decoded `Error` and the wire-level `errorId` extracted from the smallcaps payload.
The pair lets a consumer correlate the local error with the trace record minted by the originating worker without re-parsing the SES error tag.

`@endo/captp` forwards both `marshalSaveError` and `marshalLoadError` from its `makeCapTP` options through to the inner `makeMarshal` it constructs, so callers can install the hooks on either side of a CapTP connection without reaching into marshal directly.

`@endo/daemon` exposes `EndoHost.traces()` returning an `EndoTraces` facet with `lookup(errorId)`, `recent({workerId, limit})`, `clear(workerId)`, and `stats()` methods.
The daemon's worker bootstrap exports a new `EndoDaemonFacetForWorker.reportTrace(record)` capability that workers use to push trace records as outbound errors are marshaled.

// @ts-check

/**
 * The engine seam of the machine: the power to run worker incarnations
 * with (or without) engine-level heap snapshots. Ironhorse
 * (`makeIronhorseEngine`) is what the supervisor composes and XS
 * (`makeXsEngine`) the alternative; the in-process peer replay engines
 * (`peer-replay-engine.js`) are deterministic test doubles. The seam
 * stays open for future JS engines with other heap snapshot mechanisms.
 *
 * @typedef {object} WorkerEngine
 * @property {() => void} [assertStoreOwnership] fail closed when ownership is lost
 * @property {(statePath?: string) => Promise<() => Promise<void>>} [acquireStore] acquire exclusive ownership before opening a daemon
 * @property {boolean} canSnapshot whether `snapshot` returns a real
 *   engine-level snapshot ref; if false the host must retain the full
 *   journal and the engine must reconstruct state by replay
 * @property {(options: {
 *   debugName: string,
 *   snapshot: unknown,
 *   onOutbound: (message: Record<string, unknown>) => void,
 *   onOutboundBatch?: (messages: Array<Record<string, unknown>>) => void,
 * }) => Promise<WorkerIncarnation>} start `debugName` is for diagnostics
 *   only — it must not influence engine behavior. Engines may use the optional
 *   batch callback instead of the single-frame callback for a completed crank;
 *   preserve frame order and emit each frame through exactly one callback.
 * @property {(ref: unknown) => Promise<void>} [releaseSnapshot] release a
 *   superseded snapshot ref (e.g. drop its content-addressed store root);
 *   called after a newer snapshot is durably recorded
 */

/**
 * One running incarnation of a worker.
 *
 * @typedef {object} WorkerIncarnation
 * @property {(message: Record<string, unknown>) => Promise<void>} deliver
 *   deliver one duct message and run the guest to quiescence; resolves
 *   after the guest's outbound effects have been emitted
 * @property {(messages: Array<Record<string, unknown>>) => Promise<void>} [deliverBatch]
 *   deliver several duct messages as one crank: dispatch each in order,
 *   then run the guest to quiescence once (one collection, one outbound
 *   read). A host uses it for OCapN GC frames gathered for the next frame
 *   (see `durable-worker-transport.js`); the same journal must be replayed
 *   with the same batches, so an engine either always offers it or never
 *   does
 * @property {() => Promise<unknown>} snapshot capture the guest heap as
 *   a durable snapshot ref (engines with `canSnapshot: false` return
 *   null)
 * @property {() => Promise<void>} terminate kill the incarnation; the
 *   guest heap is recoverable only from a snapshot plus the journal
 */

/**
 * A deterministic guest halt: retrying the same journal would halt again.
 * It is also what a worker's transport raises once it has given the worker
 * up, whether for a halt or for a run of crashes without progress (see
 * `WorkerCrashError`), so catching one means the worker's `failure` is, or
 * is about to be, on record.
 */
export class WorkerHaltError extends Error {}

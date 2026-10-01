// @ts-check
/**
 * The store the daemon runs over, as types: a filesystem implementation
 * (`store-fs.js`) and an in-memory one for tests (`store-memory.js`) each
 * satisfy them.
 */

/**
 * The daemon-side record of one endpoint session: export descriptions,
 * resolver obligations, and the answer epoch
 * (worker-session-records.js).
 *
 * @typedef {Record<string, any>} TablesRecord
 */

/**
 * @typedef {object} WorkerMeta
 * @property {string} [debugLabel] optional human-readable label; used
 *   only in diagnostics, never as an identifier
 * @property {string} [allocationKey] host-generated key for retrying an
 *   interrupted allocation while this worker exists
 * @property {string} [startNotify] the daemon's own publication secret for
 *   the object it calls `started()` on at every startup; minted by the
 *   daemon and never handed out. The delivery is the wake — nothing
 *   else is needed, because waking a vat runs none of its code anyway, and the
 *   publication is already a retention root
 * @property {boolean} [ephemeral] this worker's heap is not a recovery
 *   baseline: the next daemon startup retires it instead of restoring it, so
 *   whatever it held dies with the process that held it
 * @property {string} [failure] deterministic halt; retained for inspection
 * @property {string} [hubDelivery] highest hub outbox sequence covered by the snapshot
 * @property {{ ref: unknown, cut?: number } | null} [snapshot]
 *   the engine snapshot and the absolute journal index (`cut`) it
 *   subsumes
 * @property {number} [outboundBase] count of worker→host OCapN
 *   frames subsumed by the recorded snapshot; frames number from here
 *   (session-lifetime sequence), so the hub's inbound watermark can
 *   drop replay-regenerated duplicates
 */

/**
 * Durable storage for one worker: its CapTP tables record, its inbound
 * message journal, and its metadata (bootstrap slot, engine snapshot ref,
 * resource export descriptions).
 *
 * The journal is indexed by absolute entry number: indices remain stable
 * across truncation, so a snapshot's recorded `journalLength` always
 * names the same suffix.
 *
 * @typedef {object} WorkerStore
 * @property {() => TablesRecord | undefined} getTablesRecord
 * @property {(record: TablesRecord) => void} setTablesRecord
 * @property {() => WorkerMeta} getMeta
 * @property {(meta: WorkerMeta) => void} setMeta
 * @property {(entry: unknown) => void} appendJournal
 * @property {(from?: number) => Array<any>} readJournal entries with
 *   absolute index >= from (entries before the truncation point are gone)
 * @property {() => number} journalLength total absolute entry count
 * @property {(upTo: number) => void} truncateJournal drops entries with
 *   absolute index < upTo; call only after a snapshot covering them is
 *   durably recorded
 */

/**
 * Durable storage for one resumable peer session: one record with its
 * identity, sequence numbers and unacknowledged frames.
 *
 * @typedef {object} SessionStore
 * @property {() => Record<string, any>} getMeta
 * @property {(meta: Record<string, any>) => void} setMeta
 */

/**
 * Content-addressed storage for the bundles a native process loads: each is
 * stored under the SHA-256 hex digest of its bytes, written once and never
 * rewritten, so a digest names the same bytes for as long as it is stored.
 *
 * @typedef {object} ThixotropeStore
 * @property {string} [statePath] filesystem ownership boundary
 * @property {() => any} getHubState the OCapN hub's persisted tables
 * @property {(state: any) => void} setHubState
 * @property {() => Array<string>} listWorkerIds
 * @property {(workerId: string) => WorkerStore} provideWorkerStore
 * @property {(workerId: string) => void} deleteWorker removes the
 *   worker's durable state (tables, journal, meta) entirely
 * @property {() => Array<string>} listSessionTokens
 * @property {(token: string) => SessionStore} provideSessionStore
 * @property {(text: string) => string} putBundle store a bundle under the
 *   digest of its bytes and return that digest; one already stored is left
 *   as it is, since the same bytes are there
 * @property {(digest: string) => string} bundlePath where a stored bundle
 *   is, for the process that loads it; nothing here says it exists
 * @property {(digest: string) => string | undefined} readBundle
 * @property {() => Array<string>} listBundles the digests stored
 * @property {(digest: string) => void} deleteBundle
 */

export {};

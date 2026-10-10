import type { ConstructionReason } from '@endo/agent-tools/adapters/mcp.js';

/**
 * The discriminant of a construction error from this server: the adapter's
 * own reasons, plus the two startup failures only this transport produces.
 */
export type ServerConstructionReason =
  ConstructionReason | 'invalid-formula-id' | 'daemon-unreachable';

/** An open daemon session, as `connectToDaemon` returns it. */
export type DaemonConnection = {
  /** The bootstrap root host. */
  host: unknown;
  /** Settles when the connection drops. */
  closed: Promise<unknown>;
  close: (reason?: Error) => void;
};

/** A record of JSON-primitive fields, as a `claude -p` stream carries them. */
export type PrimitiveRecord = Record<string, string | number | boolean | null>;

/** The parse of one `claude -p --output-format stream-json` transcript. */
export type ClaudeStreamParse = {
  outcome: { type: string; status?: number; reason?: string; detail?: string };
  /** The terminal result text. */
  text?: string;
  /** Primitive status and accounting fields. */
  fields?: PrimitiveRecord;
  usage?: PrimitiveRecord;
  subagentStats?: PrimitiveRecord;
  /** The last `rate_limit_event`, or `undefined` when telemetry is unknown. */
  quota?: Record<string, unknown>;
};

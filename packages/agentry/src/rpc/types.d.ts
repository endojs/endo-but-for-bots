// spell-out-exempt: `args` is the tool-call field name fixed by
// `pi-agent-core` events and the RPC wire vocabulary; it cannot be renamed.

/**
 * Shape definitions for the stdio JSONL RPC bridge: the language-agnostic
 * wire vocabulary from `designs/endopi-stdio-rpc-bridge.md`. Commands arrive
 * from an embedding host as LF-delimited JSON; events flow back the same way.
 * These types are the single source of truth the bridge, framing,
 * protocol, session, and serve modules share.
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';

/**
 * A decoded RPC command record. The bridge's `handleLine` checks only that
 * `type` is a string (and `id`, when present); every payload field is validated by the dispatcher
 * before use, so they are declared optional here.
 *
 * The command set (per the design): `prompt` and `steer` carry a `message`;
 * `set_model` carries `provider` and `model`; `abort`, `list_models`, and
 * `get_status` carry no payload. An optional `id` on any command is echoed
 * on every event that command produces, for correlation.
 */
export type RpcCommand = {
  type: string;
  id?: string;
  /** for `prompt` / `steer` */
  message?: string;
  /** for `set_model` */
  provider?: string;
  /** for `set_model` */
  model?: string;
};

/**
 * One model the session can switch to, as reported by `list_models`.
 */
export type ModelInfo = {
  provider: string;
  id: string;
  name: string;
};

/**
 * A wire event emitted on the output stream. The streaming events
 * (`message_start` / `message_update` / `message_end` /
 * `tool_execution_start` / `tool_execution_end` / `agent_end`) mirror the
 * daemon agent's own event stream; `endo:`-prefixed events carry Endo-only
 * affordances the base Pi surface does not define. Every event optionally
 * echoes the in-flight command's `id`.
 */
export type RpcEvent = (
  | { type: 'message_start'; message: unknown }
  | { type: 'message_update'; delta: string }
  | { type: 'endo:thinking'; delta: string }
  | { type: 'message_end'; message: unknown }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: 'agent_end' }
  | { type: 'error'; message: string }
  | { type: 'endo:ack'; command: string }
  | { type: 'models'; providers: string[]; models: ModelInfo[] }
  | { type: 'status'; model: string; busy: boolean }
) & { id?: string };

/**
 * The narrow seam the bridge drives, adapting a live `PiAgent` to the
 * command surface. `makeRpcSession` supplies the agent-backed
 * implementation; the tests supply a scripted fake.
 */
export type Session = {
  /** register a raw-event listener; returns an unsubscribe function */
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  prompt: (message: string) => Promise<void>;
  abort: () => void;
  /**
   * inject a message into the running round; with no round running, the
   * agent queues it into the next one
   */
  steer: (message: string) => void;
  /** human-readable current model */
  describeModel: () => string;
  listModels: () => { providers: string[]; models: ModelInfo[] };
  setModel: (selection: { provider: string; model: string }) => Promise<void>;
};

/**
 * The stateful strict-`\n` line decoder from `framing.js`. `push` absorbs a
 * text or byte chunk and returns whatever complete lines it now closes;
 * `flush` surfaces any buffered unterminated trailing line at end of input.
 */
export type JsonlDecoder = {
  push: (chunk: string | Uint8Array) => string[];
  flush: () => string[];
};

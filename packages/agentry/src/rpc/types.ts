// spell-out-exempt: `args` is the tool-call field name fixed by
// `pi-agent-core` events and the RPC wire vocabulary; it cannot be renamed.

import type { AgentEvent } from '@earendil-works/pi-agent-core';

/**
 * A decoded RPC command record. The bridge's `handleLine` checks only that
 * `type` is a string (and `id`, when present); every payload field is
 * validated by the dispatcher before use, so they are declared optional here.
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
 * The narrow interface the bridge drives, adapting a live `PiAgent` to the
 * command surface. `makeRpcSession` supplies the agent-backed
 * implementation; the tests supply a scripted fake.
 */
export type Session = {
  /**
   * register a raw-event listener; returns an unsubscribe function. Both are
   * host-local closures, so `makeRpcSession`'s guard passes them raw.
   */
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

export type JsonlDecoder = {
  push: (chunk: string | Uint8Array) => string[];
  flush: () => string[];
};

/**
 * The dispatcher `makeRpcBridge` returns.
 */
export type RpcBridge = {
  /** parse and dispatch one input line */
  handleLine: (line: string) => Promise<void>;
  /** resolves once no prompt round is in flight */
  idle: () => Promise<void>;
  /** stop relaying the session's events */
  close: () => void;
};

// @ts-check

/**
 * @module rpc/types
 *
 * Shape definitions for the stdio JSONL RPC bridge: the language-agnostic
 * wire vocabulary from `designs/endopi-stdio-rpc-bridge.md`. Commands arrive
 * from an embedding host as LF-delimited JSON; events flow back the same way.
 * These typedefs are the single source of truth the bridge, framing,
 * protocol, session, and serve modules share; they will become
 * `M.interface()` guards if this surface graduates into the daemon.
 */

/** @import { AgentEvent } from '@earendil-works/pi-agent-core' */

/**
 * A decoded RPC command record. The framing layer guarantees only that
 * `type` is a string; every payload field is validated by the dispatcher
 * before use, so they are declared optional here.
 *
 * The command set (per the design): `prompt` and `steer` carry a `message`;
 * `set_model` carries `provider` and `model`; `abort`, `list_models`, and
 * `get_status` carry no payload. An optional `id` on any command is echoed
 * on every event that command produces, for correlation.
 *
 * @typedef {object} RpcCommand
 * @property {string} type
 * @property {string} [id]
 * @property {string} [message] - for `prompt` / `steer`
 * @property {string} [provider] - for `set_model`
 * @property {string} [model] - for `set_model`
 */

/**
 * One model the session can switch to, as reported by `list_models`.
 *
 * @typedef {object} ModelInfo
 * @property {string} provider
 * @property {string} id
 * @property {string} name
 */

/**
 * A wire event emitted on the output stream. The streaming events
 * (`message_start` / `message_update` / `message_end` /
 * `tool_execution_start` / `tool_execution_end` / `agent_end`) mirror the
 * daemon agent's own event stream; `endo:`-prefixed events carry Endo-only
 * affordances the base Pi surface does not define. Every event optionally
 * echoes the in-flight command's `id`.
 *
 * @typedef {(
 *   | { type: 'message_start', message: unknown }
 *   | { type: 'message_update', delta: string }
 *   | { type: 'endo:thinking', delta: string }
 *   | { type: 'message_end', message: unknown }
 *   | { type: 'tool_execution_start', toolCallId: string, toolName: string, args: unknown }
 *   | { type: 'tool_execution_end', toolCallId: string, toolName: string, result: unknown, isError: boolean }
 *   | { type: 'agent_end' }
 *   | { type: 'error', message: string }
 *   | { type: 'endo:ack', command: string }
 *   | { type: 'models', providers: string[], models: ModelInfo[] }
 *   | { type: 'status', model: string, busy: boolean }
 * ) & { id?: string }} RpcEvent
 */

/**
 * The narrow seam the bridge drives, adapting a live `PiAgent` to the
 * command surface. `makeRpcSession` supplies the agent-backed
 * implementation; the tests supply a scripted fake.
 *
 * @typedef {object} Session
 * @property {(listener: (event: AgentEvent) => void) => () => void} subscribe -
 *   register a raw-event listener; returns an unsubscribe function
 * @property {(message: string) => Promise<void>} prompt
 * @property {() => void} abort
 * @property {(message: string) => void} steer
 * @property {() => string} describeModel - human-readable current model
 * @property {() => { providers: string[], models: ModelInfo[] }} listModels
 * @property {(selection: { provider: string, model: string }) => Promise<void>} setModel
 */

/**
 * The stateful strict-`\n` line decoder from `framing.js`. `push` absorbs a
 * text or byte chunk and returns whatever complete lines it now closes;
 * `flush` surfaces any buffered unterminated trailing line at end of input.
 *
 * @typedef {object} JsonlDecoder
 * @property {(chunk: string | Uint8Array) => string[]} push
 * @property {() => string[]} flush
 */

export {};

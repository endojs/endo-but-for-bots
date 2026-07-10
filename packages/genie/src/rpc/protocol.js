// @ts-check

/**
 * Translation between the daemon agent's raw event stream and the
 * language-agnostic wire vocabulary of the stdio RPC bridge.
 *
 * The underlying `pi-agent-core` `Agent` already emits events whose
 * names line up with the design's surface (`message_start`,
 * `message_update`, `message_end`, `tool_execution_start`,
 * `tool_execution_end`, `agent_end`). This module narrows each raw event
 * to the minimal, JSON-serializable shape the design specifies, drops
 * the internal book-keeping events (`agent_start`, `turn_*`,
 * `tool_execution_update`) that the wire surface does not expose, and
 * tags every event with the in-flight command's `id` for correlation.
 *
 * Assistant text deltas become `message_update` events carrying just the
 * `delta`; reasoning deltas become `endo:thinking` events, following the
 * design's posture of namespacing Endo-only affordances.
 */

import harden from '@endo/harden';

/** @import { AgentEvent } from '@earendil-works/pi-agent-core' */
/** @import { RpcEvent, ModelInfo } from './types.js' */

/**
 * Attach the correlating command `id` to a wire event when one is set.
 *
 * @template {object} T
 * @param {T} event
 * @param {string} [id]
 * @returns {T & { id?: string }}
 */
const withId = (event, id) => (id === undefined ? event : { ...event, id });

/**
 * Translate a raw agent event into a wire event, or `undefined` for the
 * internal events the wire surface does not carry.
 *
 * @param {AgentEvent} event
 * @param {string} [id]
 * @returns {RpcEvent | undefined}
 */
export const translateAgentEvent = (event, id) => {
  switch (event.type) {
    case 'message_start':
      return withId({ type: 'message_start', message: event.message }, id);
    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (inner && inner.type === 'text_delta') {
        return withId({ type: 'message_update', delta: inner.delta }, id);
      }
      if (inner && inner.type === 'thinking_delta') {
        return withId({ type: 'endo:thinking', delta: inner.delta }, id);
      }
      return undefined;
    }
    case 'message_end':
      return withId({ type: 'message_end', message: event.message }, id);
    case 'tool_execution_start':
      return withId(
        {
          type: 'tool_execution_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        },
        id,
      );
    case 'tool_execution_end':
      return withId(
        {
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        },
        id,
      );
    case 'agent_end':
      return withId({ type: 'agent_end' }, id);
    default:
      return undefined;
  }
};
harden(translateAgentEvent);

/**
 * @param {string} message
 * @param {string} [id]
 * @returns {RpcEvent}
 */
export const makeErrorEvent = (message, id) =>
  withId({ type: 'error', message }, id);
harden(makeErrorEvent);

/**
 * @param {string} command
 * @param {string} [id]
 * @returns {RpcEvent}
 */
export const makeAckEvent = (command, id) =>
  withId({ type: 'endo:ack', command }, id);
harden(makeAckEvent);

/**
 * @param {{ providers: string[], models: ModelInfo[] }} listing
 * @param {string} [id]
 * @returns {RpcEvent}
 */
export const makeModelsEvent = (listing, id) =>
  withId(
    { type: 'models', providers: listing.providers, models: listing.models },
    id,
  );
harden(makeModelsEvent);

/**
 * @param {{ model: string, busy: boolean }} status
 * @param {string} [id]
 * @returns {RpcEvent}
 */
export const makeStatusEvent = (status, id) =>
  withId({ type: 'status', model: status.model, busy: status.busy }, id);
harden(makeStatusEvent);

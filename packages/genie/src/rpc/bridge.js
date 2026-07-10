// @ts-check

/**
 * The stdio RPC bridge dispatcher.
 *
 * Parses one JSON command per input line, drives a {@link Session}, and
 * emits wire events. It subscribes to the session's raw event stream once
 * and relays every event (translated to the wire vocabulary) tagged with
 * the in-flight prompt's `id`.
 *
 * A prompt round runs concurrently with input parsing: `handleCommand`
 * starts the round without awaiting its completion so that mid-round
 * `steer` and `abort` commands, which arrive on later input lines, reach
 * the agent while it is still working. The session is single-flight — a
 * `prompt` received while a round is in progress is rejected with an
 * error rather than silently queued (concurrent sessions are the design's
 * later multiplexing phase).
 */

import harden from '@endo/harden';

import {
  makeAckEvent,
  makeErrorEvent,
  makeModelsEvent,
  makeStatusEvent,
  translateAgentEvent,
} from './protocol.js';

/** @import { RpcCommand, RpcEvent, Session } from './types.js' */

/**
 * @param {unknown} err
 * @returns {string}
 */
const describeError = err => {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
};

/**
 * @param {object} options
 * @param {Session} options.session
 * @param {(event: RpcEvent) => void} options.write
 * @param {(message: string) => void} [options.log]
 */
export const makeRpcBridge = ({ session, write, log = () => {} }) => {
  let busy = false;
  /** @type {string | undefined} */
  let currentId;

  const unsubscribe = session.subscribe(event => {
    const wire = translateAgentEvent(event, currentId);
    if (wire) {
      write(wire);
    }
    if (event.type === 'agent_end') {
      busy = false;
      currentId = undefined;
    }
  });

  /**
   * @param {RpcCommand} command
   */
  const handleCommand = async command => {
    await null;
    const { type } = command;
    const id = command.id;
    switch (type) {
      case 'prompt': {
        if (typeof command.message !== 'string') {
          write(makeErrorEvent('prompt requires a string "message"', id));
          return;
        }
        if (busy) {
          write(
            makeErrorEvent(
              'agent is busy; steer or abort the current round first',
              id,
            ),
          );
          return;
        }
        busy = true;
        currentId = id;
        const message = command.message;
        // Fire the round without awaiting completion so that steer/abort
        // commands on subsequent input lines can interleave. Round
        // completion is observed via the `agent_end` event above; only a
        // synchronous/asynchronous prompt failure is handled here.
        Promise.resolve()
          .then(() => session.prompt(message))
          .catch(err => {
            busy = false;
            currentId = undefined;
            write(makeErrorEvent(describeError(err), id));
          });
        return;
      }
      case 'steer': {
        if (typeof command.message !== 'string') {
          write(makeErrorEvent('steer requires a string "message"', id));
          return;
        }
        session.steer(command.message);
        write(makeAckEvent('steer', id));
        return;
      }
      case 'abort': {
        session.abort();
        write(makeAckEvent('abort', id));
        return;
      }
      case 'list_models': {
        write(makeModelsEvent(session.listModels(), id));
        return;
      }
      case 'set_model': {
        if (
          typeof command.provider !== 'string' ||
          typeof command.model !== 'string'
        ) {
          write(
            makeErrorEvent(
              'set_model requires string "provider" and "model"',
              id,
            ),
          );
          return;
        }
        try {
          await session.setModel({
            provider: command.provider,
            model: command.model,
          });
          write(makeAckEvent('set_model', id));
        } catch (err) {
          write(makeErrorEvent(describeError(err), id));
        }
        return;
      }
      case 'get_status': {
        write(makeStatusEvent({ model: session.describeModel(), busy }, id));
        return;
      }
      default: {
        log(`ignoring unknown command type: ${String(type)}`);
        write(makeErrorEvent(`unknown command type: ${String(type)}`, id));
      }
    }
  };

  /**
   * @param {string} line
   */
  const handleLine = async line => {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }
    let command;
    try {
      command = JSON.parse(trimmed);
    } catch (err) {
      write(makeErrorEvent(`invalid JSON: ${describeError(err)}`));
      return;
    }
    if (
      command === null ||
      typeof command !== 'object' ||
      Array.isArray(command)
    ) {
      write(makeErrorEvent('each record must be a JSON object'));
      return;
    }
    if (typeof command.type !== 'string') {
      write(
        makeErrorEvent('each record must have a string "type"', command.id),
      );
      return;
    }
    await handleCommand(command);
  };

  const close = () => {
    if (unsubscribe) {
      unsubscribe();
    }
  };

  return harden({ handleLine, handleCommand, close });
};
harden(makeRpcBridge);

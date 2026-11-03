// @ts-nocheck - E() generics don't compose cleanly with FarRef + JSDoc
/* eslint-disable no-await-in-loop */
/**
 * Inbox follow loop for the Lal agent worker.
 *
 * Announces the worker on first wake, then follows the guest's
 * `followMessages()` iterator and races each `next()` against a
 * caller-supplied cancellation signal. For each settled inbound message the
 * configured `runOneRound` callback drives one chat round; LLM errors are
 * reported back to the sender as a reply so the conversation does not
 * silently stall.
 *
 * `spawnWorkerLoop` in `agent.js` is the sole composer of this loop; it
 * supplies the per-worker `runOneRound` (bound to a particular `PiAgent`)
 * and the cancellation accessor.
 */

import { parseLocator } from '@endo/daemon/locator.js';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { parseCompactCommand } from './compaction.js';

/** @import { InboxMessage } from './agent.types.js' */

/**
 * Run the worker's inbox follow loop. Sends the greeting, then loops over
 * inbound messages until cancellation or the iterator drains.
 *
 * @param {object} args
 * @param {any} args.powers - Guest powers (manager's own or sub-guest's).
 * @param {() => Promise<Promise<unknown> | null>} args.getCancelled
 *   Resolver returning the worker's cancellation promise (or null if no
 *   cancellation surface is configured).
 * @param {(prompt: string) => Promise<void>} args.runOneRound
 *   Per-round runner, bound to this worker's `PiAgent`.
 * @param {(command: { instructions: string | undefined }) => Promise<string>} args.handleCompactCommand
 *   Applies a `/compact` command from `@host` and returns the reply text.
 * @returns {Promise<void>}
 */
export const runInboxLoop = async ({
  powers,
  getCancelled,
  runOneRound,
  handleCompactCommand,
}) => {
  /**
   * Build the user-role content for an inbound message. lal's prompt is
   * intentionally minimal: the LLM is expected to call listMessages() to
   * inspect the inbox itself.
   *
   * @returns {string}
   */
  const formatInboundMessage = () =>
    'You have new mail. Check your messages and respond appropriately.';
  // Announce ourselves with a call to action.
  await E(powers).send(
    '@host',
    [
      "Hello! I'm ready to help.\n\n" +
        'Send me a message to get started — in Chat, type ' +
        '`@` followed by my name and your request.\n\n' +
        'A few things to try:\n' +
        '- Ask me what I can do\n' +
        '- Ask me to list your inventory\n' +
        '- Ask me to help write a program\n\n' +
        'Type `/help` to see all available Chat commands.',
    ],
    [],
    [],
  );

  /** @type {string | undefined} */
  const selfLocator = await E(powers).locate('@self');
  const hostLocator = await E(powers).locate('@host');
  /**
   * Compares formula identity because `locate` adds connection hints that a
   * message's `from` locator lacks.
   *
   * @param {string} locator
   * @returns {boolean}
   */
  const isFromHost = locator => {
    try {
      const from = parseLocator(locator);
      const host = parseLocator(hostLocator);
      return from.number === host.number && from.node === host.node;
    } catch {
      return false;
    }
  };
  const cancelled = await getCancelled();
  const cancelledSignal = cancelled
    ? cancelled.then(
        () => ({ cancelled: true }),
        () => ({ cancelled: true }),
      )
    : null;

  // Follow messages and route each to the correct transcript chain.
  //
  // Re-emission of an already-processed inbound number indicates the
  // sender called daemon `editMessage`: a partial submission that has
  // settled, or an amendment of an already-settled message.  We do
  // not start a fresh transcript turn for such re-emissions; the
  // agent can call `messageHistory(n)` to retrieve the prior text
  // if it needs to reason about the change.
  /** @type {Set<bigint>} */
  const seenInboundNumbers = new Set();

  const messageIterator = iterateReader(E(powers).followMessages());
  while (true) {
    const nextMessage = messageIterator.next();
    const raced = cancelledSignal
      ? await Promise.race([
          cancelledSignal,
          nextMessage.then(result => ({ cancelled: false, result })),
        ])
      : { cancelled: false, result: await nextMessage };
    if (raced.cancelled) {
      try {
        await messageIterator.return?.();
      } catch {
        // ignore iterator return errors on cancellation
      }
      break;
    }
    const { value: message, done } = raced.result;
    if (done) {
      break;
    }
    const inboxMessage =
      /** @type {InboxMessage & {type?: string, messageId?: string, replyTo?: string, done?: boolean}} */ (
        message
      );
    const {
      from: fromLocator,
      number,
      type,
      done: messageDone = true,
    } = inboxMessage;

    // Skip our own outbound messages; only act on inbound mail.
    // eslint-disable-next-line @endo/restrict-comparison-operands
    if (fromLocator !== selfLocator) {
      // Skip partial (in-flight) submissions: wait until the sender
      // marks the message done before spinning up an LLM turn.
      if (messageDone === false) {
        console.log(
          `[mail] Message #${number} is not yet done; deferring until settled`,
        );
        // eslint-disable-next-line no-continue
        continue;
      }
      if (seenInboundNumbers.has(number)) {
        console.log(
          `[mail] Message #${number} was edited after settlement; ` +
            `not rerunning. Use messageHistory(${number}) for the prior text.`,
        );
        // eslint-disable-next-line no-continue
        continue;
      }
      seenInboundNumbers.add(number);
      // Only the host spends the worker's credentials on a summary or steers
      // what it keeps, so from any other sender `/compact` is ordinary mail.
      // The command is dismissed so that the LLM does not take it for a request
      // on its next `listMessages()`, and so that a restart does not replay it.
      const compactCommand = isFromHost(fromLocator)
        ? parseCompactCommand(inboxMessage)
        : undefined;
      if (compactCommand) {
        try {
          const text = await handleCompactCommand(compactCommand);
          await E(powers).reply(number, [text], [], []);
          await E(powers).dismiss(number);
        } catch (error) {
          console.error('[agent] /compact failed:', error);
          try {
            await E(powers).reply(
              number,
              [`/compact failed: ${error?.message ?? error}`],
              [],
              [],
            );
            await E(powers).dismiss(number);
          } catch (replyError) {
            console.error('[agent] Failed to notify sender:', replyError);
          }
        }
        // eslint-disable-next-line no-continue
        continue;
      }
      console.log(`[mail] New message #${number} (type: ${type || 'package'})`);
      try {
        await runOneRound(formatInboundMessage());
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error('[agent] LLM error, notifying sender:', errorMessage);
        try {
          await E(powers).reply(
            number,
            [`LLM provider error: ${errorMessage}`],
            [],
            [],
          );
        } catch (replyError) {
          console.error('[agent] Failed to notify sender:', replyError);
        }
      }
    }
  }
};
harden(runInboxLoop);

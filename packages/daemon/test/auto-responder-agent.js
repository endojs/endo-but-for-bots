import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';
import { makeExo } from '@endo/exo';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

export const AutoResponderInterface = M.interface(
  'Auto responder',
  {},
  { defaultGuards: 'passable' },
);

/**
 * A host-pinned agent caplet. Endowed with an agent's own powers, it follows
 * that agent's mailbox and autonomously answers every message the agent
 * receives — replying with an acknowledgement and then dismissing the
 * message — for as long as this incarnation lives.
 *
 * Because the caplet is a persisted formula, re-incarnating it (after its
 * worker is cancelled or after the daemon restarts) re-runs `make`, which
 * restarts the follow loop against the still-durable mailbox, so the agent
 * resumes responding to new messages.
 *
 * @param {any} powers - The agent (a host or guest) whose mailbox to service.
 */
export const make = async powers => {
  // The agent's own locator, used to tell inbound messages (which we answer)
  // from the agent's own outbound traffic — including the replies we send.
  const selfLocator = await E(powers).locate('@self');
  let responded = 0;

  const serviceMailbox = async () => {
    for await (const message of iterateReader(E(powers).followMessages())) {
      // Only react to messages the agent receives, never to messages it sent
      // (a reply carries a `replyTo`), so the acknowledgements below cannot
      // feed the loop back into itself.
      const inbound =
        message.from !== selfLocator && message.replyTo === undefined;
      if (inbound) {
        if (typeof message.messageId === 'string') {
          // Echo the prompt so each acknowledgement is distinguishable from a
          // backlog replayed by a fresh `followMessages` after a restart.
          const prompt = message.strings?.[0] ?? String(message.number);
          await E(powers).reply(message.number, [`ack:${prompt}`], [], []);
        }
        await E(powers).dismiss(message.number);
        responded += 1;
      }
    }
  };

  // Fire-and-forget: the loop runs for the life of this incarnation. When the
  // worker is cancelled the follow reader rejects and the loop unwinds.
  serviceMailbox().catch(() => {});

  return makeExo('Auto responder', AutoResponderInterface, {
    /**
     * The number of received messages this incarnation has answered. Resets to
     * zero whenever the caplet is re-incarnated, so a post-restart increment
     * proves the follow loop resumed.
     */
    respondedCount() {
      return responded;
    },
  });
};

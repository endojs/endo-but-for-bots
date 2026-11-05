// @ts-check
// prefer-endo-primitives-exempt: disposal hooks require callable remotables;
// makeExo creates method-bearing objects, not callable facets.

/* global setTimeout, clearTimeout */

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';
import { M } from '@endo/patterns';

import {
  AGENT_RESPONDER_DEFAULTS,
  formulaIdOfLocator,
  makeAgentResponder,
} from './agent-responder.js';
import { makeSnapshotJournal } from './snapshot-journal.js';

const AgentResponderInterface = M.interface('AgentResponder', {});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(AgentResponderInterface);

const AgentResponderControlInterface = M.interface('AgentResponderControl', {
  setPaused: M.callWhen(M.boolean())
    .optional(M.opt(M.string()))
    .returns(M.undefined()),
  describe: M.callWhen().returns(M.record()),
  retry: M.callWhen(M.string()).returns(M.undefined()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(AgentResponderControlInterface);

/**
 * A timer in this worker that does not keep it alive.
 * @param delayMs
 * @param callback
 */
const schedule = (delayMs, callback) => {
  const timer = setTimeout(callback, delayMs);
  /** @type {any} */ (timer).unref?.();
  return () => clearTimeout(timer);
};

/**
 * The responder's snapshot journal lives in the guest's `@pins`, which the
 * harness's facet cannot name, and is released with the guest.
 *
 * @param {any} guest
 * @param {string} directory
 */
const pinnedNamespace = (guest, directory) =>
  harden({
    list: () => E(guest).list('@pins', directory),
    lookup: name => E(guest).lookup(['@pins', directory, name]),
    storeValue: (value, name) =>
      E(guest).storeValue(value, ['@pins', directory, name]),
    remove: name => E(guest).remove('@pins', directory, name),
  });

/**
 * A positive integer setting, or the default.
 *
 * @param {string | undefined} value
 * @param {number} fallback
 */
const positiveOr = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Make a daemon caplet entry point for one harness. Its powers are a directory
 * holding the agent's `guest`, the agent's one-agent `endowment`, and the
 * `launcher`. It is retained in that guest's `@pins`, so it survives restart.
 *
 * The launcher is handed a control object rather than looking up this formula.
 * The daemon terminates any worker that references a formula it collects, so a
 * launcher holding responders would die with the first agent deleted. A control
 * object is not a formula, so it does not count as such a reference.
 *
 * @param {(endowment: { powers: any, inference: any, model: string,
 *   maxTokens?: number }) => Promise<{ runTurn: (prompt: string,
 *   signal: AbortSignal) => Promise<{ text?: string }>,
 *   dispose?: () => Promise<void> }>} makeTurnRunner
 */
export const makeAgentResponderCaplet = makeTurnRunner =>
  harden(
    /**
     * @param {any} powers
     * @param {any} context
     * @param {{ env?: Record<string, string> }} [options]
     */
    async (powers, context, { env = {} } = {}) => {
      const guest = await E(powers).lookup('guest');
      const endowment = await E(powers).lookup('endowment');
      const stateDirectory = env.AGENT_RESPONDER_STATE_DIRECTORY;
      if (!(await E(guest).has('@pins', stateDirectory))) {
        await E(guest).makeDirectory(['@pins', stateDirectory]);
      }
      const selfId = formulaIdOfLocator(await E(guest).locate('@self'));

      /** @type {undefined | { model: string, runner: any }} */
      let current;
      /**
       * A reattachment can change the model, so each turn asks again. The
       * inference facet itself follows the agent's current grant.
       *
       * @param {{ prompt: string }} message
       * @param {AbortSignal} signal
       */
      const runTurn = async ({ prompt }, signal) => {
        const {
          powers: harnessPowers,
          inference,
          model,
        } = await E(endowment).forTurn();
        if (current?.model !== model) {
          await current?.runner.dispose?.();
          current = harden({
            model,
            runner: await makeTurnRunner(
              harden({ powers: harnessPowers, inference, model }),
            ),
          });
        }
        return /** @type {any} */ (current).runner.runTurn(prompt, signal);
      };

      const responder = await makeAgentResponder({
        guest,
        selfId: /** @type {string} */ (selfId),
        journal: makeSnapshotJournal({
          powers: pinnedNamespace(guest, stateDirectory),
          prefix: 'responder-v1-',
        }),
        runTurn,
        schedule,
        initialBackoffMs: positiveOr(
          env.AGENT_RESPONDER_INITIAL_BACKOFF_MS,
          AGENT_RESPONDER_DEFAULTS.initialBackoffMs,
        ),
      });

      let stopFollowing = false;
      const follow = async () => {
        await null;
        while (!stopFollowing) {
          try {
            // eslint-disable-next-line no-await-in-loop, no-underscore-dangle
            for await (const _message of iterateReader(
              E(guest).followMessages(),
            )) {
              responder.notify();
            }
          } catch (error) {
            if (!stopFollowing) {
              console.error('Agent responder subscription failed', error);
            }
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve =>
            schedule(AGENT_RESPONDER_DEFAULTS.initialBackoffMs, resolve),
          );
        }
      };
      void follow();

      if (context !== undefined) {
        await E(context).addDisposalHook(
          Far('Stop agent responder', () => {
            stopFollowing = true;
            responder.stop();
          }),
        );
      }
      const launcher = await E(powers).lookup('launcher');
      await E(launcher).register(
        env.AGENT_RESPONDER_NAME,
        makeExo('AgentResponderControl', AgentResponderControlInterface, {
          setPaused: (paused, startAfter) =>
            responder.setPaused(paused, startAfter),
          describe: () => responder.describe(),
          retry: number => responder.retry(number),
        }),
      );
      return makeExo('AgentResponder', AgentResponderInterface, {});
    },
  );
harden(makeAgentResponderCaplet);

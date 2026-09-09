// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
} from '@endo/hosted-agent';

/**
 * Give each explicit user turn a fresh bounded resource generation. The inner
 * factory owns durable state and the pending-tool/process-reap barrier. This
 * wrapper never retries a dispatched send or renews a budget within a turn.
 *
 * @param {any} factory Operator-owned Codex factory, not a model capability.
 */
export const makeRenewingCodexBackend = factory => {
  const sessions = new Map();
  const chains = new Map();
  /** @template T
   * @param {string} id
   * @param {() => Promise<T>} operation
   */
  const ordered = (id, operation) => {
    const result = (chains.get(id) || Promise.resolve()).then(operation);
    const settled = result.then(
      () => {},
      () => {},
    );
    chains.set(id, settled);
    void settled.then(() => {
      if (chains.get(id) === settled) chains.delete(id);
    });
    return result;
  };
  return makeExo('RenewingCodexBackendFactory', HostedBackendFactoryInterface, {
    describe: () => E(factory).describe(),
    listModels: () => E(factory).listModels(),
    create: (spec, toolSet) =>
      ordered(spec.sessionId, async () => {
        // Preserve the predecessor's cleanup authority if handover fails.
        // The inner client itself fences sends once teardown has started.
        let current = await E(factory).create(spec, toolSet);
        const identity = harden({});
        sessions.set(spec.sessionId, identity);
        let renewing = false;
        let cancellationEpoch = harden({});
        const assertCurrent = () => {
          sessions.get(spec.sessionId) === identity ||
            Fail`Codex session was superseded or terminated`;
        };
        const run = makeExo('RenewingCodexRun', HostedTurnBackendInterface, {
          send: async (prompt, options) => {
            assertCurrent();
            !renewing || Fail`Codex turn admission is already in progress`;
            const admittedEpoch = cancellationEpoch;
            renewing = true;
            try {
              return await ordered(spec.sessionId, async () => {
                assertCurrent();
                const status = await E(current.run).status();
                (!status.active && status.pendingToolCalls === 0) ||
                  Fail`Codex previous turn is still active or has unsettled tool calls`;
                // create() stops and reaps the predecessor before mounting the
                // same durable volumes and loading the last saved checkpoint.
                current = await E(factory).create(spec, toolSet);
                admittedEpoch === cancellationEpoch ||
                  Fail`Codex turn interrupted before dispatch`;
                return E(current.run).send(prompt, options);
              });
            } finally {
              renewing = false;
            }
          },
          models: async () => {
            assertCurrent();
            // Catalog discovery must not depend on an expired idle namespace.
            return E(factory).listModels();
          },
          interrupt: async () => {
            assertCurrent();
            // Reserve cancellation before awaiting anything. A generation
            // still being provisioned must never dispatch the canceled prompt.
            cancellationEpoch = harden({});
            // Do not queue behind send(): turn/start can itself be blocked.
            // The current client must observe cancellation during startup too.
            await E(current.run).interrupt();
            // If handover is pending, wait until its no-dispatch check settles
            // before reporting the terminal cancellation barrier complete.
            await ordered(spec.sessionId, async () => {});
          },
          acknowledge: checkpoint =>
            ordered(spec.sessionId, async () => {
              assertCurrent();
              return E(current.run).acknowledge(checkpoint);
            }),
          status: async () => {
            assertCurrent();
            const status = await E(current.run).status();
            return harden({ ...status, renewing });
          },
          help: () =>
            'Codex: fresh bounded lease before each send; no automatic mid-turn replay.',
        });
        const admin = makeExo(
          'RenewingCodexAdmin',
          HostedTurnBackendAdminInterface,
          {
            terminate: () =>
              ordered(spec.sessionId, async () => {
                // A stale admin never tears down a successor's generation.
                if (sessions.get(spec.sessionId) !== identity) return;
                await E(current.admin).terminate();
                sessions.delete(spec.sessionId);
              }),
            help: () =>
              'Stop this logical Codex session, including its current generation.',
          },
        );
        return harden({ run, admin });
      }),
    destroy: spec =>
      ordered(spec.sessionId, async () => {
        await E(factory).destroy(spec);
        sessions.delete(spec.sessionId);
      }),
    help: () =>
      'Codex subscription factory with bounded per-turn lease renewal.',
  });
};
harden(makeRenewingCodexBackend);

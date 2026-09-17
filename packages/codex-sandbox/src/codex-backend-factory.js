// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
} from '@endo/hosted-agent';
import { makeSessionRegistry } from '@endo/hosted-agent/session-registry.js';

import { normalizeCodexModelDescriptor } from './codex-models.js';
import { assertContainerMounts } from './codex-hosted-policy.js';
import { withEndoToolInstructions } from './endo-tools.js';

/**
 * Floot's protocol adapter over daemon-owned native sessions. No slices,
 * leases, credentials, or storage deletion authority live in this factory.
 * Failed owner stops stay retryable and fence only their own session.
 *
 * @param {object} powers
 * @param {(sessionId: string, request: Record<string, any>, tools: any) => Promise<any>} powers.provisionSession
 * @param {(sessionId: string) => Promise<void>} powers.stopSession
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 * @param {readonly any[]} powers.models
 * @param {boolean} [powers.publicInternetEnabled]
 */
export const makeCodexBackendFactory = ({
  provisionSession,
  stopSession,
  removeSession,
  models,
  publicInternetEnabled = false,
}) => {
  const catalog = harden(models.map(normalizeCodexModelDescriptor));
  const sessions = makeSessionRegistry();
  const policies = harden(
    publicInternetEnabled ? ['off', 'public-internet'] : ['off'],
  );
  /** @param {unknown} value */
  const sessionIdFor = value => {
    (typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) ||
      Fail`Invalid Codex session identity`;
    return /** @type {string} */ (value);
  };
  /**
   * @param {Record<string, any>} spec
   * @param {any} toolSet
   */
  const create = async (spec, toolSet) => {
    const sessionId = sessionIdFor(spec.sessionId);
    const networkPolicy = spec.networkPolicy ?? 'off';
    policies.includes(networkPolicy) || Fail`Unsupported Codex network policy`;
    spec.cwd === undefined ||
      spec.cwd === '/workspace' ||
      Fail`Codex cwd must be /workspace`;
    const containerMounts = assertContainerMounts(spec.containerMounts);
    const model =
      spec.model === undefined
        ? (catalog.find(entry => entry.default)?.id ?? catalog[0]?.id)
        : spec.model;
    const selected = catalog.find(entry => entry.id === model);
    if (selected === undefined) throw Fail`Unknown Codex model`;
    // Floot represents an unselected thinking option as the empty string.
    // Resolve it here, before recording the native session's immutable plan.
    const { reasoningEffort: requestedEffort, ...rest } = spec;
    const reasoningEffort =
      requestedEffort === undefined || requestedEffort === ''
        ? (selected.defaultReasoningEffort ?? undefined)
        : requestedEffort;
    reasoningEffort === undefined ||
      selected.reasoningEfforts.includes(reasoningEffort) ||
      Fail`Unsupported Codex reasoning effort`;
    const request = harden({
      ...rest,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      model,
      networkPolicy,
      containerMounts,
    });
    return sessions.inOrder(sessionId, async () => {
      await sessions.stop(sessionId);
      const client = await provisionSession(sessionId, request, toolSet);
      let stopped = false;
      /** @type {Promise<void> | undefined} */
      let stopping;
      const terminate = () => {
        if (stopped) return Promise.resolve();
        stopping ??= Promise.resolve()
          .then(async () => {
            await stopSession(sessionId);
            stopped = true;
            sessions.release(sessionId, terminate);
          })
          .finally(() => {
            stopping = undefined;
          });
        return stopping;
      };
      const run = makeExo('HostedTurnBackend', HostedTurnBackendInterface, {
        send: (prompt, options) =>
          E(client).send(
            prompt,
            withEndoToolInstructions(options, spec.systemPrompt),
          ),
        models: async () =>
          harden((await E(client).models()).map(normalizeCodexModelDescriptor)),
        interrupt: () => E(client).interrupt(),
        acknowledge: checkpoint => E(client).acknowledge(checkpoint),
        status: () => E(client).status(),
        help: () =>
          'Codex turns and checkpoint acknowledgement through the daemon session owner.',
      });
      const admin = makeExo(
        'HostedTurnBackendAdmin',
        HostedTurnBackendAdminInterface,
        {
          terminate,
          help: () =>
            'Stops native work through the session owner; keeps durable session state.',
        },
      );
      sessions.retain(sessionId, terminate);
      return harden({ run, admin });
    });
  };
  return makeExo('CodexBackendFactory', HostedBackendFactoryInterface, {
    async describe() {
      return harden({
        id: 'codex',
        title: 'Codex',
        kind: 'hosted',
        continuity: 'opaque-reconciled',
        toolOwnership: 'endo',
        supportedNetworkPolicies: policies,
      });
    },
    async listModels() {
      return catalog;
    },
    create,
    async stop(spec) {
      const sessionId = sessionIdFor(spec.sessionId);
      return sessions.inOrder(sessionId, async () => {
        // A fresh factory has no retained admin, but the daemon still owns
        // the durable session and any outstanding native cleanup.
        if (!(await sessions.stop(sessionId))) await stopSession(sessionId);
      });
    },
    async destroy(spec) {
      const sessionId = sessionIdFor(spec.sessionId);
      return sessions.inOrder(sessionId, async () => {
        await sessions.stop(sessionId);
        await removeSession(sessionId);
      });
    },
    help: () =>
      'Codex hosted factory: describe, listModels, create, stop (keeps state), destroy.',
  });
};
harden(makeCodexBackendFactory);

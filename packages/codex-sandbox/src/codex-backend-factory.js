// @ts-check

import { Fail, q } from '@endo/errors';
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
import { CODEX_TOOL_NAMES, withEndoToolInstructions } from './endo-tools.js';

/** @import { makeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js' */

/**
 * Floot's protocol adapter over daemon-owned native sessions. No slices,
 * leases, credentials, or storage deletion authority live in this factory.
 * Failed owner stops stay retryable and fence only their own session.
 *
 * @param {object} powers
 * @param {(sessionId: string, request: Record<string, any>, tools: any) => Promise<any>} powers.provisionSession
 * @param {(sessionId: string) => Promise<void>} powers.stopSession
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 * @param {ReturnType<typeof makeBackendCatalog>} powers.catalog What each
 *   account of the broker lists, from the ChatGPT model list; a new
 *   session's pin is admitted by it in the provisioner.
 * @param {boolean} [powers.publicInternetEnabled]
 * @param {() => Promise<Array<{ id: string, label: string }>>} [powers.listSubscriptions]
 *   The provider's subscriptions a session may be pinned to; none when the
 *   broker holds one credential.
 */
export const makeCodexBackendFactory = ({
  provisionSession,
  stopSession,
  removeSession,
  catalog,
  publicInternetEnabled = false,
  listSubscriptions = async () => [],
}) => {
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
    // `auto` is the default and is not recorded; an id must be one the broker
    // declares now, so a typo fails here and not on the first turn.
    const subscription =
      spec.subscription === undefined || spec.subscription === 'auto'
        ? undefined
        : spec.subscription;
    if (subscription !== undefined) {
      const declared = await listSubscriptions().catch(() => {
        throw Fail`Codex subscriptions cannot be listed right now`;
      });
      declared.some(entry => entry.id === subscription) ||
        Fail`Unknown Codex subscription ${q(subscription)}`;
    }
    const containerMounts = assertContainerMounts(spec.containerMounts);
    // Shape only: whether the account lists the model, and the effort it
    // offers, is the provisioner's to admit for a new pin against the
    // catalog; a reopen keeps its recorded pin. Floot represents an
    // unselected thinking option as the empty string.
    const {
      model: requestedModel,
      reasoningEffort: requestedEffort,
      subscription: _requestedSubscription,
      ...rest
    } = spec;
    requestedModel === undefined ||
      (typeof requestedModel === 'string' && requestedModel.length <= 256) ||
      Fail`Codex model id must be a bounded string`;
    requestedEffort === undefined ||
      (typeof requestedEffort === 'string' && requestedEffort.length <= 64) ||
      Fail`Codex reasoning effort must be a bounded string`;
    const request = harden({
      ...rest,
      ...(subscription === undefined ? {} : { subscription }),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedEffort ? { reasoningEffort: requestedEffort } : {}),
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
      // A broker that cannot be asked right now says nothing here; the
      // descriptor is not the place to fail.
      const subscriptions = (await listSubscriptions().catch(() => [])).map(
        (/** @type {any} */ { id, label, pinnedOnly }) => ({
          id,
          label,
          ...(pinnedOnly === true ? { pinnedOnly: true } : {}),
        }),
      );
      return harden({
        id: 'codex',
        title: 'Codex',
        kind: 'hosted',
        continuity: 'opaque-reconciled',
        toolOwnership: 'endo',
        // Whose credential a session here spends, and, when the broker holds
        // several, which a session may be pinned to.
        providerId: 'codex',
        ...(subscriptions.length > 0 ? { subscriptions } : {}),
        supportedNetworkPolicies: policies,
        // What a system prompt must know about this place. Codex receives
        // Endo's tools under their own names, except the one the adapter
        // renames to keep it apart from Codex's native exec; it has its own
        // shell and file tools, and its cwd is the session workspace.
        promptEnvironment: {
          toolNamePrefix: '',
          toolNames: CODEX_TOOL_NAMES,
          nativeTools: true,
          workspacePath: '/workspace',
        },
      });
    },
    modelCatalog: subscriptionId => catalog.catalog(subscriptionId),
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
      'Codex hosted factory: describe, modelCatalog(subscriptionId?), create, stop (keeps state), destroy.',
  });
};
harden(makeCodexBackendFactory);

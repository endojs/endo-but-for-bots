// @ts-check
// Codex as a Floot hosted backend.
//
// The factory itself is the shared one (`@endo/hosted-agent/backend-factory-kit.js`):
// it validates Floot's request, serializes operations per session, retains
// each session's termination until the daemon owner's stop succeeds, and
// exposes the hosted turn protocol. No slices, leases, credentials, or
// storage deletion authority live here. This module declares what is Codex's:
// the operator's container mounts, a working directory that is always the
// workspace, a reasoning effort the provider declares per model, a real
// checkpoint acknowledgement (continuity is opaque and reconciled through
// the client), and the model list the client itself answers.

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeHostedBackendFactory } from '@endo/hosted-agent/backend-factory-kit.js';

import { normalizeCodexModelDescriptor } from './codex-models.js';
import { assertContainerMounts } from './codex-hosted-policy.js';
import { CODEX_TOOL_NAMES, withEndoToolInstructions } from './endo-tools.js';

/** @import { makeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js' */
/** @import { DeclaredSubscription } from '@endo/hosted-agent/subscription-lister.js' */

/**
 * @param {object} powers
 * @param {(sessionId: string, request: Record<string, any>, tools: any) => Promise<any>} powers.provisionSession
 * @param {(sessionId: string) => Promise<void>} powers.stopSession
 * @param {(sessionId: string) => Promise<void>} powers.removeSession
 * @param {ReturnType<typeof makeBackendCatalog>} powers.catalog What each
 *   account of the broker lists, from the ChatGPT model list; a new
 *   session's pin is admitted by it in the provisioner.
 * @param {boolean} [powers.publicInternetEnabled]
 * @param {() => Promise<DeclaredSubscription[]>} [powers.listSubscriptions]
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
}) =>
  makeHostedBackendFactory({
    label: 'Codex',
    provisionSession,
    stopSession,
    removeSession,
    catalog,
    publicInternetEnabled,
    listSubscriptions,
    describe: () => ({
      id: 'codex',
      title: 'Codex',
      continuity: 'opaque-reconciled',
      nativeContextFormat: 'codex-rollout-v1',
      // Whose credential a session here spends, and, when the broker holds
      // several, which a session may be pinned to.
      providerId: 'codex',
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
    }),
    readContainerMounts: assertContainerMounts,
    readRequest: spec => {
      spec.cwd === undefined ||
        spec.cwd === '/workspace' ||
        Fail`Codex cwd must be /workspace`;
      // Shape only: the effort a model offers is the provisioner's to admit
      // against the catalog. Floot represents an unselected thinking option
      // as the empty string.
      const effort = spec.reasoningEffort;
      effort === undefined ||
        (typeof effort === 'string' && effort.length <= 64) ||
        Fail`Codex reasoning effort must be a bounded string`;
      return effort ? { reasoningEffort: effort } : {};
    },
    makeRun: ({ client, spec }) => ({
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
    }),
    adminHelp:
      'Stops native work through the session owner; keeps durable session state.',
  });
harden(makeCodexBackendFactory);

// @ts-check

/**
 * `make-unconfined` entry point for `codex-sandbox/backend`.
 *
 * This caplet used to be minted with `powersName: '@agent'` and to keep the
 * host agent in its closure for its whole lifetime, using it to create and
 * write a `codex-subscription-state/<sessionId>/{entries,anchors,thread}`
 * petstore subtree. An agent's entire naming authority, held for three
 * directories and a credential.
 *
 * It now takes a record of exactly three capabilities, stored as a marshalled
 * value and named as its powers:
 *
 *   credential    — one pinned Secrets record's read and conditional
 *                   in-place replacement, and nothing else
 *                   (`@endo/hosted-agent/managed-renewable-credentials.js`)
 *   sandbox       — the owned native runtime's factory facet, constructed with
 *                   a null scratch provider so capability-based construction is
 *                   refused
 *   stateProvider — one host directory per session under a configured root,
 *                   with ownership markers, owned by the daemon
 *
 * Formula configuration still contains paths and model policy, never
 * credentials, and the refresh authority still never leaves the host.
 *
 * @module
 */

import { Fail, b } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeSandboxSessionId } from '@endo/hosted-agent/session-plan.js';

import { makeStoredAuditJournal } from './audit-journal.js';
import { readCodexHostConfigEnv } from './codex-host-config.js';
import { makeCodexSessionState } from './codex-session-store.js';
import { makeHostedCodexSubscription } from './hosted-subscription.js';
import { assertSubscriptionAccount } from './subscription-setup.js';

const MiB = 1024 * 1024;

/**
 * The powers bundle setup stores and names. Checked by method presence rather
 * than by shape alone: each of these is a remote presence whose methods are not
 * properties to inspect, so a missing one has to fail here, at construction,
 * rather than at a session's first use.
 * @param {any} powers
 */
const readPowers = async powers => {
  const bundle = await powers;
  (bundle && typeof bundle === 'object') ||
    Fail`Codex backend requires a powers record of {credential, sandbox, stateProvider}`;
  for (const name of ['credential', 'sandbox', 'stateProvider']) {
    const capability = bundle[name];
    (capability &&
      (typeof capability === 'object' || typeof capability === 'function')) ||
      Fail`Codex backend powers is missing ${b(name)}`;
  }
  return harden({
    credential: bundle.credential,
    sandbox: bundle.sandbox,
    stateProvider: bundle.stateProvider,
  });
};

/**
 * @param {any} powers The stored `{credential, sandbox, stateProvider}` record.
 * @param {any} context
 * @param {{env?:Record<string,string>}} [options]
 */
export const make = async (powers, context, { env = {} } = {}) => {
  const config = readCodexHostConfigEnv(env);
  const { credential, sandbox, stateProvider } = await readPowers(powers);

  let state;
  try {
    state = JSON.parse(
      globalThis.atob((await E(credential).readBase64WithGeneration()).base64),
    );
  } catch {
    throw Fail`Invalid subscription credential`;
  }
  const accountRef = assertSubscriptionAccount(config.accountRef, state);
  // This is deliberately not an implicit import or OAuth retry. The setup
  // operation must explicitly normalize a full auth.json before minting us.
  state.version === 'BrokerOAuthStateV1' ||
    Fail`Import the Codex subscription credential before setup`;

  // Floot session ids are mixed-case and may carry characters a directory name
  // should not; the shared derivation lowercases, slugs and appends a digest of
  // the original, so two sessions cannot collide into one state directory.
  /** @param {string} sessionId */
  const stateIdFor = sessionId => makeSandboxSessionId(sessionId, 'codex');

  /** @param {string} sessionId */
  const openSessionState = async sessionId => {
    const { directory } = await E(stateProvider).prepareSessionDirectory(
      stateIdFor(sessionId),
    );
    return makeCodexSessionState(directory);
  };

  const runtime = await makeHostedCodexSubscription({
    ...config,
    ownerId: config.ownerId,
    accountRef,
    credential,
    sandbox,
    context,
    ...(config.diagnostics
      ? {
          onDiagnostic: (/** @type {unknown} */ diagnostic) =>
            console.error('Codex upstream failure', JSON.stringify(diagnostic)),
          audit: (/** @type {any} */ { event, requests }) =>
            console.error('Codex broker event', event, String(requests)),
        }
      : {}),
    makeAuditJournal: async (/** @type {{sessionId: string}} */ spec) => {
      const { entries, anchors } = await openSessionState(spec.sessionId);
      return makeStoredAuditJournal(entries, {
        journalId: `codex-${spec.sessionId}`,
        sessionId: spec.sessionId,
        anchorPowers: anchors,
        maxEntryBytes: MiB,
        maxTotalBytes: 16 * MiB,
        maxAnchorBytes: 16 * MiB,
      });
    },
    loadThreadState: async (/** @type {string} */ sessionId) => {
      // Reading must not create: a checkpoint is read before anything is
      // provisioned, and preparing here would leave a state directory behind
      // for a session that never started.
      const located = await E(stateProvider).locateSessionDirectory(
        stateIdFor(sessionId),
      );
      if (located.directory === undefined) return harden({});
      return (await makeCodexSessionState(located.directory)).readThread();
    },
    saveThreadState: async (
      /** @type {string} */ sessionId,
      /** @type {unknown} */ checkpoint,
    ) => {
      const session = await openSessionState(sessionId);
      await session.writeThread(checkpoint);
    },
    removeSessionState: async (/** @type {string} */ sessionId) => {
      await E(stateProvider).removeSessionDirectory(stateIdFor(sessionId));
    },
  });
  return runtime.backend;
};
harden(make);

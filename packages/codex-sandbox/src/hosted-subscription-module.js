// @ts-check

import { createHash } from 'node:crypto';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makePetstoreAuditJournal } from './audit-journal.js';
import { makeHostedCodexSubscription } from './hosted-subscription.js';
import { assertSubscriptionAccount } from './subscription-setup.js';

const StoreInterface = M.interface('CodexPrivateStore', {
  list: M.call().returns(M.promise()),
  has: M.call(M.string()).returns(M.promise()),
  lookup: M.call(M.string()).returns(M.promise()),
  storeValue: M.call(M.any(), M.string()).returns(M.promise()),
});

/** Persistent caplet entry point. Formula configuration contains paths and
 * model policy, never credentials. The secret and its rotator stay host-side.
 * @param {any} host
 * @param {any} context
 * @param {{env?:Record<string,string>}} [options]
 */
export const make = async (host, context, { env = {} } = {}) => {
  const config = JSON.parse(env.CODEX_HOST_CONFIG || '{}');
  const secretPath = config.secretPath ?? [
    'secrets',
    'codex-subscription-auth',
  ];
  const catalog = await E(host).lookup(['@secrets', 'catalog']);
  const entries = await E(catalog).list();
  const entry = entries.find(item =>
    item.petNamePaths.some(
      path => JSON.stringify(path) === JSON.stringify(secretPath),
    ),
  );
  entry || Fail`Configured Codex subscription secret is missing`;
  const secret = await E(host).lookup(secretPath);
  let state;
  try {
    state = JSON.parse(
      globalThis.atob((await E(secret).readBase64WithGeneration()).base64),
    );
  } catch {
    throw Fail`Invalid subscription credential`;
  }
  const accountRef = assertSubscriptionAccount(config.accountRef, state);
  // This is deliberately not an implicit import or OAuth retry. The setup
  // operation must explicitly normalize a full auth.json before minting us.
  state.version === 'BrokerOAuthStateV1' ||
    Fail`Import the Codex subscription credential before setup`;
  const hostId = await E(host).identify('@agent');
  (typeof hostId === 'string' && hostId.length > 0) ||
    Fail`Cannot identify Codex host`;
  const ownerId = `codex-${createHash('sha256').update(hostId).digest('hex').slice(0, 56)}`;
  const root = ['codex-subscription-state'];
  const sessionPath = sessionId => {
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) ||
      Fail`Invalid session identity`;
    return [...root, sessionId];
  };
  const directory = async path => {
    if (!(await E(host).has(...path))) await E(host).makeDirectory(path);
  };
  const store = path =>
    makeExo('Codex private store', StoreInterface, {
      list: () => E(host).list(...path),
      has: name => E(host).has(...path, name),
      lookup: name => E(host).lookup([...path, name]),
      storeValue: (value, name) => E(host).storeValue(value, [...path, name]),
    });
  const runtime = await makeHostedCodexSubscription({
    ...config,
    ownerId,
    accountRef,
    secret,
    secretAdmin: entry.admin,
    context,
    ...(config.diagnostics === true
      ? {
          onDiagnostic: diagnostic =>
            console.error('Codex upstream failure', JSON.stringify(diagnostic)),
          audit: ({ event, requests }) =>
            console.error('Codex broker event', event, String(requests)),
        }
      : {}),
    initializeState: () => directory(root),
    volumeLimits: {
      workspaceBytes: BigInt(config.workspaceBytes),
      stateBytes: BigInt(config.stateBytes),
    },
    makeAuditJournal: async spec => {
      const base = sessionPath(spec.sessionId);
      await directory(base);
      await directory([...base, 'entries']);
      await directory([...base, 'anchors']);
      return makePetstoreAuditJournal(store([...base, 'entries']), {
        journalId: `codex-${spec.sessionId}`,
        sessionId: spec.sessionId,
        anchorPowers: store([...base, 'anchors']),
        maxEntryBytes: 1024 * 1024,
        maxTotalBytes: 16 * 1024 * 1024,
        maxAnchorBytes: 16 * 1024 * 1024,
      });
    },
    loadThreadState: async sessionId => {
      const path = [...sessionPath(sessionId), 'thread'];
      return (await E(host).has(...path)) ? E(host).lookup(path) : {};
    },
    saveThreadState: async (sessionId, checkpoint) => {
      const base = sessionPath(sessionId);
      await directory(base);
      await E(host).storeValue(checkpoint, [...base, 'thread']);
    },
    removeSessionState: async sessionId => {
      const path = sessionPath(sessionId);
      if (await E(host).has(...path)) await E(host).remove(...path);
    },
  });
  return runtime.backend;
};
harden(make);

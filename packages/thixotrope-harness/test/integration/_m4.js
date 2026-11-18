// @ts-check
/**
 * Helpers of the M4 integration tests and perf checks (W4.8;
 * `designs/m4-interfaces.md` 17, 18): the `m4` state template, one served
 * state with the Secrets manager, the subscriptions admin and the sealed
 * writer at hand, credential Secrets written as sealed boxes, pools over the
 * fake subscription and OAuth servers (127.0.0.1), turns through the
 * Composer, and the "no credential anywhere" grep (acceptance 15).
 *
 * Token values are built at run time (`tokenOf`) and are never shaped like
 * a provider key. The wrapping key file lives under H/tmp, outside the
 * state directory (D-6), through THIX_HARNESS_SECRETS_KEY.
 *
 * The importer must have installed the guest prelude first
 * (`test/unit/_m1a-prelude.js`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { sealTo } from '../../resources/agent-host/impl/secrets/seal.js';
import { formatCredential } from '../../resources/agent-host/impl/subscriptions/credentials.js';
/* eslint-enable import/no-relative-packages */
import {
  agentHostDirectory,
  makeProvision,
  provisionSteps,
  templateIdFor,
} from '../../scripts/provision-steps.js';
import {
  ensureTemplate,
  processesUnder,
  startFromTemplate,
} from '../template/index.js';
import {
  makeSlice,
  readLog,
  requestId,
  turnWithInput,
  waitFor,
} from './_m1a-slice.js';
import { grepState } from './_m2-secrets.js';

const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;

export const CLAUDE_MODEL = 'claude-sonnet-5';
export const CODEX_MODEL = 'gpt-fake-1';

/**
 * A placeholder token, built at run time (never key-shaped), unique per
 * run so a grep hit cannot be an old file.
 * @param {string} tag
 */
export const tokenOf = tag =>
  ['fake', 'w48', tag, randomBytes(6).toString('hex')].join('-');

/**
 * Prefixes of every token a test uses: `tokenOf` here, and the fake OAuth
 * server's minted access and refresh tokens (`fake-<kind>-<serial>-<hex>`),
 * whose values a test never sees. Grepping for the prefixes finds every one
 * of them (acceptance 15).
 */
export const TOKEN_PREFIXES = harden([
  'fake-w48-',
  'fake-access-',
  'fake-refresh-',
]);

/**
 * The `m4` template: M1a's provisioning (the real session and exec
 * programs, no spares) under an id that also covers the manager vat's M4
 * part (`durable-subscriptions.js` is bundled into the installed
 * `durable.js`, which `templateIdFor` hashes without its imports).
 */
export const m4Template = async () => {
  const base = await templateIdFor({ prefix: 'm4' });
  const hash = createHash('sha256').update(base);
  hash.update(
    readFileSync(path.join(agentHostDirectory, 'durable-subscriptions.js')),
  );
  const run = makeProvision();
  return ensureTemplate({
    id: `m4-${hash.digest('hex').slice(0, 10)}`,
    provision: async context => {
      await run(context);
    },
  });
};

/**
 * Point the adapter's Secrets store at a key file under H/tmp for this
 * process (every supervisor started afterwards inherits it).
 * @param {import('ava').ExecutionContext} t
 * @param {string} tag
 */
export const useKeyFile = (t, tag) => {
  const keyDir = path.join(harnessTmp, `w48-${tag}-${process.pid}`);
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  t.teardown(() => rmSync(keyDir, { recursive: true, force: true }));
  process.env.THIX_HARNESS_SECRETS_KEY = path.join(keyDir, 'secrets.key');
  return keyDir;
};

/**
 * One served `m4` state: the slice (factory, Composer, Live), the Secrets
 * manager, its subscriptions admin and the sealed writer.
 * @param {import('ava').ExecutionContext} t
 * @param {string} tag
 */
export const startM4 = async (t, tag) => {
  useKeyFile(t, tag);
  const template = await m4Template();
  const state = await startFromTemplate(template, { t });
  return m4View(state);
};

/**
 * The M4 view of a served state: the slice, the Secrets manager, its
 * subscriptions admin and the sealed writer. `state` is a template state
 * (tests) or a perf harness `Provisioned` (perf checks: no kill or stop).
 * @param {any} state
 */
export const m4View = async state => {
  const slice = await makeSlice(state);
  const view = {
    /** @type {import('../template/index.js').TemplateState} */
    state,
    slice,
    /** @type {any} */ secrets: undefined,
    /** @type {any} */ subs: undefined,
    /** @type {any} */ writer: undefined,
    /** @type {any} */ publicKey: undefined,
    /** After a restart: new presences from the new client. */
    refresh: async () => {
      await slice.refresh();
      view.secrets = await E(slice.admin).getSecrets();
      view.subs = await E(view.secrets).subscriptions();
      view.writer = await E(view.secrets).openWriter();
      view.publicKey = await E(view.writer).publicKey();
      return view;
    },
  };
  return view.refresh();
};

/** @typedef {Awaited<ReturnType<typeof m4View>>} M4State */

/**
 * A credential value in the stored form.
 * @param {'claude' | 'codex'} provider
 * @param {{ accessToken: string, refreshToken?: string, expiresAtMs?: number, accountId?: string, pendingRefresh?: { startedAtMs: number } }} fields
 */
export const credentialText = (provider, fields) =>
  formatCredential(
    harden({
      provider,
      expiresAtMs: Date.now() + 3_600_000,
      ...(provider === 'claude' ? { scopes: ['user:inference'] } : {}),
      ...fields,
    }),
  );

/**
 * Create a Secret and write `value` into it as a sealed box.
 * @param {M4State} m4
 * @param {string} label
 * @param {string} value
 */
export const makeValueSecret = async (m4, label, value) => {
  const secret = await E(m4.secrets).create(
    harden({ label, description: `credential of ${label}` }),
  );
  const { generation } = await E(m4.writer).replace(
    secret,
    sealTo(m4.publicKey, value),
  );
  return { secret, generation };
};

/**
 * Members and a pool over the fake servers.
 * @param {M4State} m4
 * @param {object} options
 * @param {'claude-pool' | 'codex-pool'} options.kind
 * @param {string} options.label
 * @param {Array<{ label: string, credential: any }>} options.members
 * @param {string} options.baseUrl the fake subscription server
 * @param {string} [options.tokenUrl] the fake OAuth server's
 * @param {string} [options.logPath]
 * @param {Record<string, unknown>} [options.extra] other `PoolSpec` fields
 */
export const makePool = async (
  m4,
  { kind, label, members, baseUrl, tokenUrl, logPath, extra = {} },
) => {
  const provider = kind === 'claude-pool' ? 'claude' : 'codex';
  const made = [];
  for (const member of members) {
    made.push(
      // eslint-disable-next-line no-await-in-loop -- in declaration order
      await E(m4.subs).makeMember(
        harden({
          provider,
          label: member.label,
          credential: member.credential,
        }),
      ),
    );
  }
  const usageUrl =
    provider === 'claude'
      ? `${baseUrl}/api/oauth/usage`
      : `${baseUrl}/backend-api/wham/usage`;
  const backend = await E(m4.subs).makePool(
    harden({
      kind,
      label,
      members: made,
      baseUrl,
      usageUrl,
      ...(tokenUrl === undefined ? {} : { tokenUrl }),
      ...(logPath === undefined ? {} : { logPath }),
      ...extra,
    }),
  );
  return { backend, members: made };
};

/**
 * Default answers of the fake subscription server's GET routes (model
 * lists and usage reads), reused for every request.
 */
export const fakeDefaults = harden({
  'GET /v1/models': { file: 'claude-models.json' },
  'GET /backend-api/codex/models': { file: 'codex-models.json' },
  'GET /api/oauth/usage': { file: 'claude-usage.json' },
  'GET /backend-api/wham/usage': { file: 'codex-usage.json' },
});

/**
 * Submit through the Composer and wait for the turn's `end` or `abort`.
 * @param {M4State} m4
 * @param {any} session
 * @param {ReturnType<typeof import('./_m1a-slice.js').collect>} live
 * @param {string} input
 * @param {number} [ms]
 */
export const runTurn = async (m4, session, live, input, ms = 60_000) => {
  const from = live.deliveries.length;
  const receipt = await E(m4.slice.composer).submit(
    session,
    input,
    requestId(),
  );
  const { turnId } = await E(receipt.turn).getStatus();
  const at = await live.until(
    event =>
      (event.type === 'end' || event.type === 'abort') &&
      event.turnId === turnId,
    ms,
    from,
  );
  const status = await E(receipt.turn).getStatus();
  return { turnId, last: live.deliveries[at].event, status, receipt };
};

/**
 * A session on `backend` with its live subscription.
 * @param {M4State} m4
 * @param {any} backend
 * @param {Record<string, unknown>} [extra] more `CreateOptions`
 */
export const openSession = async (m4, backend, extra = {}) => {
  const session = await E(m4.slice.factory).createSession(
    harden({
      title: 'w48',
      preset: m4.slice.chatOnly,
      backend,
      at: Date.now(),
      ...extra,
    }),
  );
  const live = await m4.slice.subscribe(session);
  return { session, live };
};

/** POSTs of the fake subscription server (inference requests). */
export const posts = (/** @type {any} */ server) =>
  server.requests().filter((/** @type {any} */ r) => r.method === 'POST');

/**
 * Lines of a pool's event log.
 * @param {string} logPath
 */
export const poolLog = logPath => readLog(logPath);

/**
 * Acceptance 15: no encoding of any of `values` under the state directory,
 * in the extra files (event logs) or in the captured supervisor stderr.
 * @param {import('ava').ExecutionContext} t
 * @param {M4State} m4
 * @param {string[]} values token values used by the test
 * @param {{ files?: string[], control?: string }} [options]
 */
export const assertNoCredential = async (
  t,
  m4,
  values,
  { files = [], control } = {},
) => {
  /** @type {string[]} */
  const hits = [];
  for (const value of values) {
    // eslint-disable-next-line no-await-in-loop
    for (const { file, encoding } of await grepState(m4.state.root, value))
      hits.push(`${path.relative(m4.state.root, file)} (${encoding})`);
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text.includes(value)) hits.push(path.basename(file));
    }
    if (m4.state.stderrTail().includes(value)) hits.push('stderr');
  }
  t.deepEqual(hits, [], 'no credential value anywhere');
  if (control !== undefined) {
    const seen = await grepState(m4.state.root, control);
    t.true(seen.length > 0, 'the control text is found by the grep');
  }
};

/** The provisioning step of M4 (H-8), run directly with its options. */
export const subscriptionsStep = () => {
  const step = provisionSteps.find(s => s.name === 'subscriptions');
  if (step === undefined) throw Error('no subscriptions provisioning step');
  return step;
};

export { waitFor };

/**
 * SIGKILL the supervisor and every process under the state directory at
 * once (the adapter and workers included, so nothing the adapter would do
 * next reaches a server), then serve the same directory again and take new
 * presences.
 * @param {M4State} m4
 */
export const killAndRestart = async m4 => {
  for (const { pid } of processesUnder(m4.state.root)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
  await m4.state.kill();
  const timings = await m4.state.restart();
  await m4.refresh();
  return timings;
};

/**
 * The pools of the Secrets manager, in creation order.
 * @param {M4State} m4
 */
export const listPools = async m4 => (await E(m4.subs).listPools()).pools;

/**
 * Wait until the turn with `input` has settled on `session`; its state.
 * @param {any} session
 * @param {string} input
 * @param {number} [ms]
 */
export const settledState = async (session, input, ms = 30_000) => {
  /** @type {any} */
  let found;
  await waitFor(
    async () => {
      const page = await E(session).getHistoryPage();
      found = turnWithInput(page, input);
      return found !== undefined && found.state !== 'running';
    },
    ms,
    `the turn ${input} settled`,
    100,
  );
  return found;
};

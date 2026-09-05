// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { main } from '../setup-forgejo-credential.js';

const AUDIENCE = 'https://git.example';

/**
 * Records what the setup asked the host to do. `credential` is whatever is
 * already filed under the credential name, or undefined when the name is free.
 *
 * @param {object} [options]
 * @param {{ audience: string, kind: string }} [options.credential]
 */
const makeAgent = ({ credential } = {}) => {
  /** @type {{ provided: any[], rotated: any[] }} */
  const calls = { provided: [], rotated: [] };
  const cap = {};
  const controller = {
    async inspect() {
      return credential;
    },
    async rotate(material) {
      calls.rotated.push(material);
    },
  };
  const agent = {
    async lookup(name) {
      if (credential === undefined) {
        throw new Error(`${name} is not bound`);
      }
      return cap;
    },
    async getGitCredentialController(candidate) {
      if (candidate !== cap) {
        throw new Error('not a daemon-minted Git credential cap');
      }
      return controller;
    },
    async provideBasicCredential(name, options) {
      calls.provided.push({ name, ...options });
      return cap;
    },
  };
  return { agent, calls };
};

/**
 * Set env vars for one test and restore them afterwards.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, string>} env
 */
const withEnv = (t, env) => {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  t.teardown(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
};

test('a host with no forge password provisions nothing', async t => {
  withEnv(t, { ENDO_FORGEJO_FLOOT_PW: '', ENDO_FORGEJO_URL: AUDIENCE });
  const { agent, calls } = makeAgent();

  await main(agent);

  t.deepEqual(calls.provided, []);
  t.deepEqual(calls.rotated, []);
});

test('an unbound name is minted', async t => {
  withEnv(t, {
    ENDO_FORGEJO_FLOOT_PW: 'hunter2',
    ENDO_FORGEJO_URL:
      'https://embedded:must-not-leak@git.example/org/repo.git?token=nope',
  });
  const { agent, calls } = makeAgent();

  await main(agent);

  t.deepEqual(calls.provided, [
    {
      name: 'forgejo-credential',
      audience: AUDIENCE,
      username: 'floot',
      password: 'hunter2',
    },
  ]);
  t.deepEqual(calls.rotated, []);
});

test('an invalid forge URL is rejected without provisioning', async t => {
  withEnv(t, {
    ENDO_FORGEJO_FLOOT_PW: 'hunter2',
    ENDO_FORGEJO_URL: 'ssh://git.example/org/repo.git',
  });
  const { agent, calls } = makeAgent();

  await t.throwsAsync(() => main(agent), {
    message: /absolute HTTP\(S\) URL/,
  });
  t.deepEqual(calls.provided, []);
  t.deepEqual(calls.rotated, []);
});

// The regression this setup exists to prevent: re-minting would bind the name
// to a fresh formula and leave every GitRemote from the previous process
// holding a revoked cap, which only surfaces when a push fails.
test('a bound name is rotated in place, not re-minted', async t => {
  withEnv(t, { ENDO_FORGEJO_FLOOT_PW: 'hunter2', ENDO_FORGEJO_URL: AUDIENCE });
  const { agent, calls } = makeAgent({
    credential: { audience: AUDIENCE, kind: 'basic' },
  });

  await main(agent);

  t.deepEqual(calls.rotated, [{ username: 'floot', password: 'hunter2' }]);
  t.deepEqual(calls.provided, []);
});

test('a credential for another audience is replaced rather than rotated', async t => {
  withEnv(t, { ENDO_FORGEJO_FLOOT_PW: 'hunter2', ENDO_FORGEJO_URL: AUDIENCE });
  const { agent, calls } = makeAgent({
    credential: { audience: 'https://git.elsewhere', kind: 'basic' },
  });

  await main(agent);

  t.deepEqual(calls.rotated, []);
  t.is(calls.provided.length, 1);
  t.is(calls.provided[0].audience, AUDIENCE);
});

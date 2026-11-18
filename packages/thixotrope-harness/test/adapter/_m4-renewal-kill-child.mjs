// @ts-check
// W4.4 kill points K-5 and K-6 (designs/m4-interfaces.md 10): one adapter
// incarnation in a child process renews a member credential and is
// SIGKILLed by the parent at the kill point.
//
//   node _m4-renewal-kill-child.mjs <job.json>
//
// job: { files, key, provider, tokenUrl, mode: 'k5' | 'k6' }
// - k5: the token request never leaves: `fetch` prints `posting` and waits
//   forever, so the parent kills after the intent write and before the POST.
// - k6: the real fetch; the fake OAuth server holds its answer and the
//   parent kills before the write-back.
import '@endo/init';

import { readFileSync } from 'node:fs';
import { argv, stdout } from 'node:process';

import { installGuestPrelude } from '../../scripts/guest-prelude.js';

installGuestPrelude();

const { makeSecretStore } =
  await import('../../resources/agent-host/impl/secrets/store.js');
const { makeCredentialAccess } =
  await import('../../resources/agent-host/impl/secrets/credential-access.js');
const { makeMemberCredential } =
  await import('../../resources/agent-host/impl/subscriptions/renewal.js');

/** @type {any} */
const job = JSON.parse(readFileSync(argv[2], 'utf8'));
const store = makeSecretStore({
  file: job.files.file,
  keyFile: job.files.keyFile,
  stateDir: job.files.stateDir,
});
/** @type {typeof globalThis.fetch} */
const blockedFetch = () => {
  stdout.write('posting\n');
  return new Promise(() => {});
};
const member = makeMemberCredential({
  access: makeCredentialAccess({ store, key: job.key }),
  provider: job.provider,
  tokenUrl: job.tokenUrl,
  ...(job.mode === 'k5' ? { fetch: blockedFetch } : {}),
  now: () => Date.now(),
});
stdout.write('started\n');
await member.current();
stdout.write('renewed\n');

// @ts-check
// W2.8 kill tests: one adapter incarnation in a child process that runs one
// step of the archive protocol and SIGKILLs itself at a named step (a real
// SIGKILL: nothing after it runs, no finally blocks, no flushes).
//
//   node _m2-archive-kill-child.mjs <job.json>
//
// job: { archiveDir, blobDir, key, killAt, action: 'seal' | 'observe',
//        req?, state? }
// `seal` answers on stdout (one JSON line) before a kill at 'after-answer';
// the seal range must be in the mirror (the child has no session vat to
// page from).
import '@endo/init';

import { readFileSync } from 'node:fs';
import { argv, kill, pid, stdout } from 'node:process';

import { installGuestPrelude } from '../../scripts/guest-prelude.js';

installGuestPrelude();

const { makeBlobStore } =
  await import('../../resources/agent-host/impl/blobs.js');
const { makeArchiveStore } =
  await import('../../resources/agent-host/impl/archive/store.js');

/** @type {any} */
const job = JSON.parse(readFileSync(argv[2], 'utf8'));
const { Far } = /** @type {any} */ (globalThis);

const die = () => kill(pid, 'SIGKILL');
const sink = Far('AgentHostSink', {
  mintBlobs: () => {
    throw Error('the kill child mints nothing');
  },
  resolveBlobs: () => {
    throw Error('the kill child resolves nothing');
  },
  resolveSessions: () => harden([job.key]),
});
const blobs = makeBlobStore({ dir: job.blobDir, sink });
const archive = makeArchiveStore({
  dir: job.archiveDir,
  blobs,
  sink,
  trace: step => {
    if (step === job.killAt) die();
  },
});
const session = Far('Session', {});
const context = Far('ContextSource', {
  page: () => {
    throw Error('the kill child has no session vat');
  },
  segments: () => harden({ segments: [] }),
});

if (job.action === 'seal') {
  const port = archive.portFor({ session, key: job.key });
  const answer = await port.seal(harden({ ...job.req, context }));
  stdout.write(`${JSON.stringify(answer)}\n`, () => {
    if (job.killAt === 'after-answer') die();
  });
} else {
  await archive.observe(session, job.key, harden(job.state));
  stdout.write('{"observed":true}\n', () => {});
}

// @ts-check
import '@endo/init';
import { E } from '@endo/far';
import harden from '@endo/harden';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { connectLocalControl } from '../src/control/local-control.js';
import { serveThixotrope } from '../src/control/supervisor.js';
import { makeMailbox } from '../src/mail/mailbox.js';
import { makeObservableMap } from '../src/observable-map.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeMailUiService } from '../src/web/mail-ui-service.js';

// Run from the package directory with the native runtime and guest bundles built.
// Arguments: push | colocated | legacy, then an optional absolute legacy service module.
// Run each mode in its own process to avoid cross-trial reference-reclamation traffic.
// Every run uses disposable state; application durability settings are untouched.
const mode = process.argv[2] ?? 'push';
if (!['push', 'colocated', 'legacy'].includes(mode))
  throw Error('Expected push, colocated, or legacy');
const trialCount = Number(process.env.THIX_MAIL_TRIALS ?? 3);
if (!Number.isInteger(trialCount) || trialCount < 1 || trialCount > 1000)
  throw Error('Expected 1–1000 measured trials');
const legacy = process.argv[3]
  ? (await import(pathToFileURL(process.argv[3]).href)).makeMailUiService
  : undefined;
if (mode === 'legacy' && !legacy)
  throw Error('Legacy mode requires a service module');
const basePowers = makeNodePowers();
const profiling = process.env.THIX_MAIL_PROFILE
  ? (await import('./mail-profile.mjs')).makeMailProfile(
      basePowers,
      process.env.THIX_MAIL_PROFILE,
      process.env.THIX_MAIL_PROFILE_WORKER,
    )
  : undefined;
const powers = profiling?.powers ?? basePowers;
const root = await mkdtemp(join(tmpdir(), 'thix-measure-mail-'));
/** @type {{epoch: number, ms: number, hub: boolean}[]} */
const writes = [];
const syncFiles = harden({
  ...powers.syncFiles,
  writeTextAtomic: (path, text, options) => {
    const start = performance.now();
    try {
      powers.syncFiles.writeTextAtomic(path, text, options);
    } finally {
      writes.push({
        epoch: performance.now(),
        ms: performance.now() - start,
        hub: path.endsWith('/hub.json'),
      });
    }
  },
});
/** @type {any} */
let supervisor;
/** @type {any[]} */
const clients = [];
/** @type {any[]} */
const results = [];
try {
  supervisor = await serveThixotrope(harden({ ...powers, syncFiles }), root, {
    idleSleepMs: 3_600_000,
    snapshotEveryDeliveries: 1_000_000,
  });
  const admin = await connectLocalControl(powers, join(root, 'control.sock'));
  clients.push(admin);
  {
    await admin.call('createWorkspace', mode);
    const client = await connectLocalControl(
      powers,
      join(root, 'control.sock'),
      { workspace: mode },
    );
    clients.push(client);
    if (mode === 'colocated') {
      await client.call(
        'evaluate',
        `(globalThis.benchMakeMap = (${makeObservableMap.toString()}), true)`,
      );
      await client.call(
        'evaluate',
        `(globalThis.benchMakeMailbox = (${makeMailbox.toString()}), true)`,
      );
      await client.call(
        'evaluate',
        "(inventory.set('mailbox', benchMakeMailbox(benchMakeMap)), true)",
      );
    }
    const book = await client.call('getAddressBook');
    await client.call(
      'evaluate',
      `(() => {
      const mailbox = inventory.get('mailbox'); let sequence = 0n;
      const contact = makeExo('BenchLoopback', M.interface('BenchLoopback', {
        status: M.call().returns(M.record()), deliver: M.call(M.any()).returns(M.promise()),
      }), {
        status: () => harden({status: 'ready'}),
        deliver: content => E(mailbox).receive(contact, ++sequence, content),
      });
      inventory.get('contacts').set('Notes', contact);
      inventory.set('counter', makeExo('BenchValue', M.interface('BenchValue', {
        read: M.call().returns(M.bigint()),
      }), {read: () => 1n}));
      return true;
    })()`,
    );
    const contacts = await client.call('lookup', 'contacts');
    const contact = await E(contacts).get('Notes');
    const counter = await client.call('lookup', 'counter');
    for (let i = 0; i < 3; i += 1) {
      await E(book).send(
        contact,
        harden([`seed ${i}`, { name: 'counter', value: counter }]),
      );
    }
    const service = (mode === 'legacy' ? legacy : makeMailUiService)({
      book,
      contacts,
      mailbox: await client.call('lookup', 'mailbox'),
      inventory: await client.call('getInventory'),
      workspace: mode,
      attachments: new Map(),
      adoptValue: (name, value) => client.call('adopt', name, value),
    });
    let latest;
    let failure;
    let wake;
    const close = await service.subscribe(
      state => {
        latest = state;
        wake?.();
      },
      error => {
        failure = error;
        wake?.();
      },
    );
    const until = async predicate => {
      const deadline = performance.now() + 120_000;
      while (!latest || !predicate(latest)) {
        if (failure) throw failure;
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          throw Error('Timed out waiting for pushed mail state');
        const timeout = new AbortController();
        try {
          await Promise.race([
            new Promise(resolve => {
              wake = resolve;
            }),
            setTimeout(remaining, undefined, { signal: timeout.signal }).then(
              () => {
                throw Error('Timed out waiting for pushed mail state');
              },
            ),
          ]);
        } finally {
          timeout.abort();
        }
      }
    };
    try {
      await until(
        state =>
          state.inbox.length === 3 &&
          state.outbox.length === 3 &&
          state.outbox.every(message => message.status === 'delivered'),
      );
      for (let trial = 0; trial < trialCount; trial += 1) {
        const marker = `${mode} ${trial}`;
        const before = await client.call('status');
        const index = writes.length;
        const epoch = Date.now();
        const window = profiling?.begin(trial);
        const start = performance.now();
        await service.send('Notes', [marker]);
        const acceptedMs = performance.now() - start;
        await until(state =>
          state.inbox.some(message => message.content.includes(marker)),
        );
        const visibleMs = performance.now() - start;
        if (window) profiling?.end(window);
        const changes = writes.slice(index);
        const after = await client.call('status');
        const row = {
          mode,
          trial,
          epoch,
          acceptedMs,
          visibleMs,
          hubWrites: changes.filter(write => write.hub).length,
          hubMs: changes
            .filter(write => write.hub)
            .reduce((sum, write) => sum + write.ms, 0),
          deliveries:
            after.timings.delivery.count - before.timings.delivery.count,
          deliveryMs:
            after.timings.delivery.milliseconds -
            before.timings.delivery.milliseconds,
          snapshots:
            after.timings.snapshot.count - before.timings.snapshot.count,
          wakes: after.timings.wake.count - before.timings.wake.count,
        };
        results.push(row);
        console.error(JSON.stringify(row));
        await until(state =>
          state.outbox.every(message => message.status === 'delivered'),
        );
        await setTimeout(100);
      }
    } finally {
      await close();
    }
    client.close();
  }
  console.log(
    JSON.stringify(
      {
        note: `Three seeds, ${trialCount} measured text sends; no periodic snapshots or idle sleeps; no HTTP/browser stage.`,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of clients) client.close();
  await supervisor?.close();
  await profiling?.dump(results);
  await rm(root, { recursive: true, force: true });
}

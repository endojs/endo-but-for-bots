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
import { makeIronhorseEngine } from '../src/ironhorse/ironhorse-engine.js';
import { readIronhorseLimits } from '../src/ironhorse/ironhorse-limits.js';
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
const recipientStrategy =
  process.env.THIX_MAIL_RECIPIENT ?? (mode === 'legacy' ? 'name' : 'reference');
const hubStrategy = process.env.THIX_MAIL_HUB ?? 'atomic';
if (!['name', 'reference'].includes(recipientStrategy))
  throw Error('Expected name or reference recipient strategy');
if (!['atomic', 'log', 'sqlite'].includes(hubStrategy))
  throw Error('Expected atomic, log, or sqlite hub strategy');
const observerStrategy = process.env.THIX_MAIL_OBSERVER ?? 'disposable';
if (!['disposable', 'durable-progress'].includes(observerStrategy))
  throw Error('Expected disposable or durable-progress observer strategy');
if (
  observerStrategy !== 'disposable' &&
  !globalThis[Symbol.for('thixotrope.mailProfile')]
)
  throw Error('Observer ablation requires profile-mail-loader.mjs');
const transferStrategy = process.env.THIX_MAIL_TRANSFERS ?? 'both';
if (!['off', 'cleanup', 'batch', 'both'].includes(transferStrategy))
  throw Error('Expected off, cleanup, batch, or both transfer strategy');
if (
  transferStrategy !== 'both' &&
  !globalThis[Symbol.for('thixotrope.mailProfile')]
)
  throw Error('Transfer ablation requires profile-mail-loader.mjs');
const gcStrategy = process.env.THIX_MAIL_GC ?? 'both';
if (!['off', 'client', 'both'].includes(gcStrategy))
  throw Error('Expected off, client, or both GC strategy');
if (gcStrategy !== 'both' && !globalThis[Symbol.for('thixotrope.mailProfile')])
  throw Error('GC ablation requires profile-mail-loader.mjs');
const gcPressure = Number(process.env.THIX_MAIL_GC_PRESSURE ?? 0);
if (!Number.isInteger(gcPressure) || gcPressure < 0 || gcPressure > 256)
  throw Error('Expected 0–256 GC-pressure reads');
if (gcPressure && typeof globalThis.gc !== 'function')
  throw Error('GC pressure requires --expose-gc');
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
const profiledPowers = profiling?.powers ?? basePowers;
const sqliteBackend =
  hubStrategy === 'sqlite'
    ? (await import('./mail-hub-sqlite.mjs')).makeMailHubSqlite(
        profiledPowers.syncFiles,
        {
          onStorage: (name, start, end) => {
            const trace = globalThis[Symbol.for('thixotrope.mailProfile')];
            trace?.span('filesystem', name, start, end, { file: 'hub' });
            // Native SQLite I/O is not visible to the JS filesystem wrappers.
            // Label its whole transaction interval, without inventing fsync timings.
          },
        },
      )
    : undefined;
const powers =
  hubStrategy === 'log'
    ? harden({
        ...profiledPowers,
        syncFiles: (await import('./mail-hub-log.mjs')).makeMailHubLog(
          profiledPowers.syncFiles,
        ),
      })
    : sqliteBackend
      ? harden({ ...profiledPowers, syncFiles: sqliteBackend.syncFiles })
      : profiledPowers;
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
  const daemonPowers = harden({ ...powers, syncFiles });
  const bootDirectory = process.env.THIX_MAIL_BOOT_DIR;
  const engine = bootDirectory
    ? makeIronhorseEngine(daemonPowers, {
        ...readIronhorseLimits(powers.environment),
        workerBinary:
          process.env.THIXOTROPE_IRONHORSE_WORKER ??
          powers.paths.fileURLToPath(
            new URL(
              '../../../target/release/thixotrope-ironhorse-worker',
              import.meta.url,
            ),
          ),
        bootPaths: ['boot.js', 'worker-peer.js'].map(name =>
          join(bootDirectory, name),
        ),
        storePath: join(root, 'heaps'),
      })
    : undefined;
  supervisor = await serveThixotrope(daemonPowers, root, {
    ...(engine ? { engine } : {}),
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
        if (gcPressure) {
          // Preparatory RPCs are excluded; collection and the resulting traffic
          // are included in the measured interval. Report this as stress load.
          await Promise.all(
            Array.from({ length: gcPressure }, () => E(counter).read()),
          );
          await new Promise(resolve => setImmediate(resolve));
          await new Promise(resolve => setImmediate(resolve));
        }
        const before = await client.call('status');
        const index = writes.length;
        const epoch = Date.now();
        const window = profiling?.begin(trial);
        const start = performance.now();
        if (gcPressure) {
          globalThis.gc();
          await new Promise(resolve => setImmediate(resolve));
          await new Promise(resolve => setImmediate(resolve));
        }
        await service.send(
          recipientStrategy === 'name'
            ? 'Notes'
            : {
                token: latest.contacts.find(entry => entry.name === 'Notes')
                  .token,
              },
          [marker],
        );
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
        strategy: {
          recipient: recipientStrategy,
          hub: hubStrategy,
          gc: gcStrategy,
          transfers: transferStrategy,
          observer: observerStrategy,
          gcPressure,
          boot: process.env.THIX_MAIL_BOOT_DIR ? 'override' : 'default',
        },
        results,
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of clients) client.close();
  try {
    await supervisor?.close();
  } finally {
    try {
      sqliteBackend?.close();
      await profiling?.dump(results);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveThixotrope } from '../src/control/supervisor.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeFsStore } from '../src/store/store-fs.js';

const powers = makeNodePowers();

/**
 * @param {import('ava').ExecutionContext} t
 * @param {string} path
 */
const serve = async (t, path) => {
  const supervisor = await serveThixotrope(powers, path, {
    engine: harden({
      ...makePeerJournalReplayEngine(powers),
      acquireStore: async () => async () => {},
    }),
  });
  t.teardown(() => supervisor.close());
  /** @param {string} [workspace] */
  const connect = async workspace => {
    const client = await connectLocalControl(
      powers,
      join(path, 'control.sock'),
      { workspace },
    );
    t.teardown(() => client.close());
    return client;
  };
  return { supervisor, connect };
};

test.serial(
  'a daemon serves many workspaces, each with its own inventory and mailbox and the one clock',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-workspaces-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    let host = await serve(t, path);
    const admin = await host.connect();
    t.deepEqual(
      (await admin.call('workspaces')).map(
        (/** @type {{name: string}} */ entry) => entry.name,
      ),
      ['default'],
    );
    await t.throwsAsync(() => admin.call('selectWorkspace', 'alice'), {
      message: /Unknown workspace/,
    });
    await t.throwsAsync(() => admin.call('createWorkspace', 'no/slash'), {
      message: /Expected a workspace name/,
    });
    const created = await admin.call('createWorkspace', 'alice');
    t.is(created.name, 'alice');
    t.like(await admin.call('createWorkspace', 'alice'), created);
    const status = await admin.call('status');
    t.deepEqual(Object.keys(status.workspaces).sort(), ['alice', 'default']);
    t.is(status.workspaces.alice, created.workerId);
    t.is(status.workspace, status.workspaces.default);

    // A connection speaks for one workspace: `default` until it selects
    // another, and the CLI's `--workspace` selects on connecting.
    const alice = await host.connect('alice');
    t.is((await alice.call('status')).workspace, created.workerId);
    t.is(await alice.call('evaluate', 'globalThis.who = "alice"'), "'alice'");
    t.is(await admin.call('evaluate', 'globalThis.who'), 'undefined');
    t.is(await admin.call('evaluate', "inventory.set('mine', 1), 1"), '1');
    t.is(await alice.call('evaluate', "inventory.has('mine')"), 'false');

    // Each workspace is handed the daemon's one clock, and provided a
    // mailbox of its own, in a vat of its own.
    t.is(await alice.call('evaluate', "inventory.has('clock')"), 'true');
    t.is(
      await alice.call(
        'evaluate',
        "E(inventory.get('clock')).after(0n).then(() => 'fired')",
      ),
      "'fired'",
    );
    t.like(await alice.call('alarmStatus'), { pending: 0 });
    const mailboxes = (await admin.call('installations')).filter(
      (/** @type {{name: string}} */ entry) => entry.name === 'mailbox',
    );
    t.deepEqual(
      mailboxes
        .map((/** @type {{workspace: string}} */ entry) => entry.workspace)
        .sort(),
      ['alice', 'default'],
    );
    const clocks = (await admin.call('installations')).filter(
      (/** @type {{name: string}} */ entry) => entry.name === 'clock',
    );
    t.is(clocks.length, 1);
    t.is(clocks[0].workspace, undefined, 'the clock belongs to the daemon');
    t.deepEqual(await alice.call('contacts'), []);
    t.deepEqual(await alice.call('inbox'), []);
    const aliceMailbox = await alice.call(
      'evaluate',
      "E(inventory.get('mailbox')).__getMethodNames__().then(() => 'own')",
    );
    t.is(aliceMailbox, "'own'");

    // An installation belongs to the workspace that asked for it: the same
    // name in two workspaces is two installations, listed with their
    // workspace, and removed from the workspace a connection speaks for.
    const directory = fileURLToPath(
      new URL('./fixtures/native-resource/', import.meta.url),
    );
    await admin.call('installNative', 'resource', directory);
    await alice.call('installNative', 'resource', directory);
    const resources = (await admin.call('installations')).filter(
      (/** @type {{name: string}} */ entry) => entry.name === 'resource',
    );
    t.deepEqual(
      resources
        .map((/** @type {{workspace: string}} */ entry) => entry.workspace)
        .sort(),
      ['alice', 'default'],
    );
    t.is(
      await alice.call(
        'evaluate',
        "E(inventory.get('resource')).initializations()",
      ),
      '1',
    );
    t.true(await alice.call('remove', 'resource'));
    t.is(await alice.call('evaluate', "inventory.has('resource')"), 'false');
    t.is(await admin.call('evaluate', "inventory.has('resource')"), 'true');
    t.false(await alice.call('remove', 'resource'));

    // Both survive a restart, found under the keys derived from their
    // names; the table names them for the host. A provided installation
    // taken out of the inventory is put there again at the next start.
    t.is(await alice.call('evaluate', "inventory.delete('mailbox')"), 'true');
    const table = JSON.parse(
      await readFile(join(path, 'workspace.json'), 'utf8'),
    );
    t.deepEqual(Object.keys(table.workspaces).sort(), ['alice', 'default']);
    admin.close();
    alice.close();
    await host.supervisor.close();
    host = await serve(t, path);
    const restored = await host.connect('alice');
    t.is((await restored.call('status')).workspace, created.workerId);
    t.is(await restored.call('evaluate', 'who'), "'alice'");
    t.is(await restored.call('evaluate', "inventory.has('clock')"), 'true');
    t.is(await restored.call('evaluate', "inventory.has('mailbox')"), 'true');
    const again = await host.connect();
    t.is(await again.call('evaluate', "inventory.get('mine')"), '1');
    t.is(await again.call('evaluate', "inventory.has('resource')"), 'true');
    // The clock each workspace holds is the one the registry holds, across
    // the restart: taking it back finds it by identity in every workspace.
    t.true(await again.call('remove', 'clock'));
    t.is(await again.call('evaluate', "inventory.has('clock')"), 'false');
    t.is(await restored.call('evaluate', "inventory.has('clock')"), 'false');
  },
);

test.serial(
  'a workspace made after the clock was removed is handed the clock the next start provides',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-workspaces-late-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    let host = await serve(t, path);
    const admin = await host.connect();
    t.true(await admin.call('remove', 'clock'));
    await admin.call('createWorkspace', 'late');
    const late = await host.connect('late');
    t.is(
      await late.call('evaluate', "inventory.has('clock')"),
      'false',
      'nothing stale is handed out',
    );
    t.is(await late.call('evaluate', "inventory.has('mailbox')"), 'true');
    admin.close();
    late.close();
    await host.supervisor.close();
    host = await serve(t, path);
    const lateAgain = await host.connect('late');
    t.like(await lateAgain.call('alarmStatus'), { pending: 0 });
    const defaultAgain = await host.connect();
    t.like(await defaultAgain.call('alarmStatus'), { pending: 0 });
  },
);

test.serial(
  'a workspace whose vat is gone is made afresh at the next start',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-workspaces-gone-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    let host = await serve(t, path);
    let admin = await host.connect();
    const { workerId } = await admin.call('createWorkspace', 'carol');
    const carol = await host.connect('carol');
    t.is(await carol.call('evaluate', "inventory.set('kept', 1), 1"), '1');
    admin.close();
    carol.close();
    await host.supervisor.close();
    // The vat halted: quarantined, it is served without an inventory, and
    // nothing roots it, so a collection sweeps it.
    const store = makeFsStore(powers, path);
    const workerStore = store.provideWorkerStore(workerId);
    workerStore.setMeta({
      ...workerStore.getMeta(),
      failure: 'halted for the test',
    });
    host = await serve(t, path);
    admin = await host.connect();
    const quarantined = await host.connect('carol');
    await t.throwsAsync(() => quarantined.call('install', 'x', '({})', []), {
      message: /quarantined/,
    });
    await t.throwsAsync(() => quarantined.call('watchInventory', harden({})), {
      message: /quarantined/,
    });
    t.true((await admin.call('collect')).includes(workerId));
    admin.close();
    quarantined.close();
    await host.supervisor.close();
    // The table named a vat that is gone: the name is served by a fresh
    // vat under its key, provided like any other.
    host = await serve(t, path);
    const fresh = await host.connect('carol');
    const status = await fresh.call('status');
    t.not(status.workspace, workerId);
    t.is(status.workspaces.carol, status.workspace);
    t.is(await fresh.call('evaluate', "inventory.has('kept')"), 'false');
    t.is(await fresh.call('evaluate', "inventory.has('clock')"), 'true');
    t.is(await fresh.call('evaluate', "inventory.has('mailbox')"), 'true');
    // The installations of the vat that is gone went with it: one mailbox
    // per workspace, in a vat of its own, as before.
    const mailboxes = (await fresh.call('installations')).filter(
      (/** @type {{name: string}} */ entry) => entry.name === 'mailbox',
    );
    t.deepEqual(
      mailboxes
        .map((/** @type {{workspace: string}} */ entry) => entry.workspace)
        .sort(),
      ['carol', 'default'],
    );
    t.is((await fresh.call('status')).workers.length, 6);
    const table = JSON.parse(
      await readFile(join(path, 'workspace.json'), 'utf8'),
    );
    t.is(table.workspaces.carol.workerId, status.workspace);
  },
);

test.serial(
  "removing the daemon's clock takes its facet back from every workspace; the next start hands out a new one",
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-workspaces-clock-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    let host = await serve(t, path);
    const admin = await host.connect();
    await admin.call('createWorkspace', 'bob');
    const bob = await host.connect('bob');
    // A name the user holds is theirs: the clock is not put over it.
    t.is(
      await bob.call('evaluate', "inventory.set('clock', 'mine'), 'mine'"),
      "'mine'",
    );
    t.true(await admin.call('remove', 'clock'));
    t.is(await admin.call('evaluate', "inventory.has('clock')"), 'false');
    t.is(await bob.call('evaluate', "inventory.get('clock')"), "'mine'");
    await t.throwsAsync(() => admin.call('alarmStatus'), {
      message: /not installed/,
    });
    admin.close();
    bob.close();
    await host.supervisor.close();
    host = await serve(t, path);
    const restored = await host.connect();
    t.like(await restored.call('alarmStatus'), { pending: 0 });
    const bobAgain = await host.connect('bob');
    t.is(await bobAgain.call('evaluate', "inventory.get('clock')"), "'mine'");
  },
);

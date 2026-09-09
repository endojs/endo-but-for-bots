// @ts-check
import '@endo/init';
import test from 'ava';

import { main } from '../setup-host.js';

/** @import { EndoHost } from '@endo/daemon' */

// These fixtures exercise only the absent sandbox-factory branch. The other
// objects already exist, so the rest of EndoHost is intentionally not mocked.
/** @param {unknown} fixture */
const asHost = fixture => /** @type {EndoHost} */ (fixture);

const ownerVariable = 'ENDO_CLAUDE_SANDBOX_OWNER_ID';

test.serial('hosts sharing a peer do not share cleanup ownership', async t => {
  const previous = process.env[ownerVariable];
  delete process.env[ownerVariable];
  t.teardown(() => {
    if (previous === undefined) delete process.env[ownerVariable];
    else process.env[ownerVariable] = previous;
  });
  const owners = [];
  const makeHost = id =>
    asHost(
      harden({
        async has(...names) {
          return names.join('/') !== 'claude-sandbox/sandbox-factory';
        },
        async getPeerInfo() {
          return harden({ node: 'shared-peer' });
        },
        async identify() {
          return id;
        },
        async makeUnconfined(_worker, _specifier, options) {
          owners.push(options.env.ENDO_SANDBOX_OWNER_ID);
        },
      }),
    );
  await main(makeHost('host-a'));
  await main(makeHost('host-b'));
  t.not(owners[0], owners[1]);
  await t.throwsAsync(() => main(makeHost(undefined)), {
    message: /Cannot identify Claude sandbox host/,
  });
  t.is(owners.length, 2);
});

test.serial(
  'existing factories are left intact without resolving an owner',
  async t => {
    await main(
      asHost(
        harden({
          async has() {
            return true;
          },
        }),
      ),
    );
    t.pass();
  },
);

test.serial(
  'persists a stable host-scoped Podman owner in the sandbox formula',
  async t => {
    const previous = process.env[ownerVariable];
    delete process.env[ownerVariable];
    t.teardown(() => {
      if (previous === undefined) delete process.env[ownerVariable];
      else process.env[ownerVariable] = previous;
    });
    const creations = [];
    const host = harden({
      async has(...names) {
        return names.join('/') !== 'claude-sandbox/sandbox-factory';
      },
      async identify(name) {
        t.is(name, '@agent');
        return 'stable-host-formula-id';
      },
      async makeUnconfined(_worker, _specifier, options) {
        creations.push(options);
      },
    });
    await main(asHost(host));
    await main(asHost(host));
    t.is(creations.length, 2);
    t.regex(creations[0].env.ENDO_SANDBOX_OWNER_ID, /^claude-[0-9a-f]{64}$/);
    t.deepEqual(creations[1].env, creations[0].env);
  },
);

test.serial(
  'honors an explicit Claude sandbox owner without resolving host identity',
  async t => {
    const previous = process.env[ownerVariable];
    process.env[ownerVariable] = 'custom-claude-owner';
    t.teardown(() => {
      if (previous === undefined) delete process.env[ownerVariable];
      else process.env[ownerVariable] = previous;
    });
    const creations = [];
    await main(
      asHost(
        harden({
          async has(...names) {
            return names.join('/') !== 'claude-sandbox/sandbox-factory';
          },
          async makeUnconfined(_worker, _specifier, options) {
            creations.push(options);
          },
        }),
      ),
    );
    t.deepEqual(creations[0].env, {
      ENDO_SANDBOX_OWNER_ID: 'custom-claude-owner',
    });
  },
);

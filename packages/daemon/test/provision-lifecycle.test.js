// @ts-check

/** @import { EndoMount } from '@endo/daemon' */
/** @import { GitRemote, ReadOnlyEndoGit, ReadWriteEndoGit } from '@endo/exo-git' */

import '@endo/init/debug.js';

import test from 'ava';

import { execFile } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { E } from '@endo/eventual-send';

import { makeProvisioningFixture } from './_provision-fixture.js';

const execFileAsync = promisify(execFile);

test.serial('provideGuest retains a neutral named authority graph', async t => {
  t.timeout(120_000);
  const fixture = await makeProvisioningFixture(t);
  const docs = join(fixture.workspace, 'docs');
  const remote = join(fixture.root, 'remote.git');
  await mkdir(docs);
  await writeFile(join(docs, 'guide.md'), 'guide\n');
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: docs });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], {
    cwd: fixture.workspace,
  });
  await execFileAsync('git', ['add', 'README.md'], { cwd: fixture.workspace });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Provision Test',
      '-c',
      'user.email=provision@example.test',
      'commit',
      '-q',
      '-m',
      'initial',
    ],
    { cwd: fixture.workspace },
  );
  await execFileAsync('git', ['init', '--bare', '-q', remote]);

  const host = await fixture.connectHost('named-authority-host');
  const calendar = await E(host).provideGuest('calendar-handle', {
    agentName: 'calendar',
  });
  await E(calendar).storeValue('original', 'value');

  const authority = harden({
    mount: {
      workspace: {
        path: fixture.workspace,
        deniedSegments: ['.env'],
      },
      docs: { path: docs, readOnly: true },
    },
    git: {
      repo: { mount: 'workspace', path: [] },
      docsHistory: { mount: 'docs', path: [], readOnly: true },
    },
    gitRemote: {
      originCap: {
        git: 'repo',
        name: 'origin',
        url: new URL(`file://${remote}`).href,
        allowedDirections: ['fetch', 'push'],
        fetchRefspecs: ['refs/heads/main:refs/remotes/origin/main'],
        pushRefspecs: ['refs/heads/main:refs/heads/main'],
        allowedBranches: ['main'],
        allowLocalFileTransport: true,
      },
    },
  });
  const guest = await E(host).provideGuest('coding-session', {
    authority,
    endowments: { calendar: ['calendar'] },
  });

  const workspace = /** @type {EndoMount} */ (
    await E(guest).lookup('workspace')
  );
  const docsMount = /** @type {EndoMount} */ (await E(guest).lookup('docs'));
  t.is(await E(workspace).readText('README.md'), 'initial\n');
  t.is(await E(docsMount).readText('guide.md'), 'guide\n');
  const repo = /** @type {ReadWriteEndoGit} */ (await E(guest).lookup('repo'));
  t.true(Array.isArray((await E(repo).status()).entries));
  const docsHistory = /** @type {ReadOnlyEndoGit} */ (
    await E(guest).lookup('docsHistory')
  );
  // eslint-disable-next-line no-underscore-dangle
  const readOnlyMethods = await E(
    /** @type {any} */ (docsHistory),
  ).__getMethodNames__();
  t.false(readOnlyMethods.includes('commit'));
  const origin = /** @type {GitRemote} */ (await E(guest).lookup('originCap'));
  const originPolicy = await E(origin).inspect();
  t.is(originPolicy.name, 'origin');
  t.deepEqual(originPolicy.allowedBranches, ['main']);
  t.is(await E(await E(guest).lookup('calendar')).lookup('value'), 'original');

  await t.throwsAsync(
    E(host).provideGit(workspace, 'unknown-git-option', {
      ignored: true,
    }),
    { message: /provideGit.*Must be|must not have properties:.*ignored/i },
  );
  await t.throwsAsync(
    E(host).provideGitRemote(repo, 'unknown-remote-option', {
      name: 'upstream',
      url: 'https://example.test/repo.git',
      ignored: true,
    }),
    {
      message: /provideGitRemote.*Must be|must not have properties:.*ignored/i,
    },
  );
  await t.throwsAsync(
    E(host).provideHost('authority-is-guest-only', {
      authority: {},
    }),
    { message: /provideHost.*Must be|must not have properties:.*authority/i },
  );

  const guestId = await E(host).identify('coding-session');
  const repoId = await E(guest).identify('repo');
  const repeated = await E(host).provideGuest('coding-session', {
    authority,
    endowments: { calendar: ['calendar'] },
  });
  t.is(await E(host).identify('coding-session'), guestId);
  t.is(await E(repeated).identify('repo'), repoId);

  await t.throwsAsync(
    E(host).provideGuest('coding-session', {
      authority: {
        ...authority,
        mount: {
          ...authority.mount,
          docs: { path: docs, readOnly: false },
        },
      },
    }),
    { message: /cannot widen or change retained authority/ },
  );
  await t.throwsAsync(
    E(host).provideGuest('coding-session', {
      authority,
      endowments: {},
    }),
    { message: /cannot widen or change retained authority/ },
  );

  await fixture.restartDaemon();
  const restartedHost = await fixture.connectHost('named-authority-restart');
  const recovered = await E(restartedHost).provideGuest('coding-session');
  t.is(await E(restartedHost).identify('coding-session'), guestId);
  t.is(await E(recovered).identify('repo'), repoId);
});

test.serial(
  'provideGuest endows immutable special names and defaults @main',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const host = await fixture.connectHost('special-name-host');
    const authority = harden({});

    const defaultGuest = await E(host).provideGuest('default-special', {
      authority,
    });
    const defaultMainId = await E(defaultGuest).identify('@main');
    t.truthy(defaultMainId, 'every freshly provisioned guest has @main');

    await E(host).provideWorker('alternate-worker');
    const alternateId = await E(host).identify('alternate-worker');
    const guest = await E(host).provideGuest('special-session', {
      authority,
      endowments: { '@main': ['alternate-worker'] },
    });
    const guestId = await E(host).identify('special-session');
    t.is(await E(guest).identify('@main'), alternateId);
    const graph = await E(E(host).diagnostics()).getFormulaGraph();
    t.true(
      graph.edges.some(
        edge =>
          edge.sourceId === guestId &&
          edge.targetId === alternateId &&
          edge.label === 'worker',
      ),
      'the endowed @main is the guest formula worker',
    );
    t.false(
      graph.edges.some(
        edge => edge.sourceId === guestId && edge.label === 'special:@main',
      ),
      'an endowed @main is not also recorded as a special name',
    );

    // A repeat that changes a special path is a policy violation, reported
    // as such even when the new source is missing.
    await t.throwsAsync(
      E(host).provideGuest('special-session', {
        authority,
        endowments: { '@main': ['absent'] },
      }),
      { message: /cannot widen or change retained authority/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('absent-special-session', {
        authority,
        endowments: { '@main': ['absent'] },
      }),
      { message: /SPECIAL_NAME_SOURCE_UNAVAILABLE/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('special-session', {
        authority,
        endowments: { '@agent': ['alternate-worker'] },
      }),
      { message: /daemon-reserved special name/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('special-session', {
        authority,
        endowments: { tool: [] },
      }),
      { message: /endowments must map guest names to host pet name paths/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('special-session', {
        authority,
        endowments: { 'not/a-pet-name': ['alternate-worker'] },
      }),
      { message: /endowments must map guest names to host pet name paths/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('conflicting-session', {
        authority: { mount: { workspace: { path: fixture.workspace } } },
        endowments: { workspace: ['alternate-worker'] },
      }),
      {
        message:
          /Endowed name "workspace" conflicts with provisioned authority/,
      },
    );
    // The value side is a pet name path, never a bare string.
    await t.throwsAsync(
      E(host).provideGuest('special-session', {
        authority,
        endowments: /** @type {any} */ ({ '@main': 'alternate-worker' }),
      }),
      { message: /Must be a copyArray/ },
    );
    // `introducedNames` is obviated by `endowments` for every guest.
    await t.throwsAsync(
      E(host).provideGuest(
        'special-session',
        /** @type {any} */ ({
          authority,
          introducedNames: { 'alternate-worker': 'tool' },
        }),
      ),
      { message: /provideGuest.*Must be: \(an object\)/ },
    );
    await t.throwsAsync(
      E(defaultGuest).provideGuest('attempted-escalation', {
        endowments: { '@main': ['@main'] },
      }),
      { message: /target has no method "provideGuest"/ },
    );
    await t.throwsAsync(E(guest).remove('@main'), {
      message: /Invalid pet name "@main"/,
    });
    await E(host).provideWorker('replacement-worker');
    // A single endowments map carries both an ordinary (mutable) introduction
    // and a special (indelible) endowment, partitioned solely by the `@` prefix.
    const unifiedGuest = await E(host).provideGuest('unified-endowments', {
      authority,
      endowments: {
        '@main': ['replacement-worker'],
        tool: ['alternate-worker'],
      },
    });
    const replacementId = await E(host).identify('replacement-worker');
    t.is(await E(unifiedGuest).identify('@main'), replacementId);
    t.is(await E(unifiedGuest).identify('tool'), alternateId);
    // Ordinary endowments remain mutable; special endowments are indelible.
    await E(unifiedGuest).remove('tool');
    t.false(await E(unifiedGuest).has('tool'));
    await t.throwsAsync(E(unifiedGuest).remove('@main'), {
      message: /Invalid pet name "@main"/,
    });

    await fixture.restartDaemon();
    const restartedHost = await fixture.connectHost('special-name-restart');
    const recovered = await E(restartedHost).provideGuest('special-session');
    t.is(await E(recovered).identify('@main'), alternateId);
    await t.throwsAsync(
      E(restartedHost).provideGuest('special-session', {
        authority,
        endowments: { '@main': ['replacement-worker'] },
      }),
      { message: /cannot widen or change retained authority/ },
    );
  },
);

test.serial(
  'provideGuest reserves every daemon-bound special name but @main',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const host = await fixture.connectHost('reserved-special-host');
    await E(host).provideWorker('some-worker');
    for (const reserved of [
      '@agent',
      '@self',
      '@host',
      '@mail',
      '@nets',
      '@planes',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(
        E(host).provideGuest(`reserved-${reserved.slice(1)}`, {
          endowments: { [reserved]: ['some-worker'] },
        }),
        { message: /daemon-reserved special name/ },
        reserved,
      );
    }
    const guest = await E(host).provideGuest('main-override', {
      endowments: { '@main': ['some-worker'] },
    });
    t.is(
      await E(guest).identify('@main'),
      await E(host).identify('some-worker'),
    );
    await t.throwsAsync(
      E(host).provideGuest('main-override', {
        endowments: { '@main': ['some-worker'] },
      }),
      { message: /Special endowments are indelible/ },
    );
  },
);

test.serial(
  'retained special names survive renaming their host source',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const host = await fixture.connectHost('retained-special-host');
    const authority = harden({});
    await E(host).provideWorker('source-worker');
    const sourceId = await E(host).identify('source-worker');
    const endowments = harden({ '@main': ['source-worker'] });
    await E(host).provideGuest('stable-session', { authority, endowments });

    await E(host).remove('source-worker');
    const missing = await E(host).provideGuest('stable-session', {
      authority,
      endowments,
    });
    t.is(await E(missing).identify('@main'), sourceId);

    await E(host).provideWorker('source-worker');
    const rebound = await E(host).provideGuest('stable-session', {
      authority,
      endowments,
    });
    t.is(await E(rebound).identify('@main'), sourceId);
  },
);

test.serial(
  'a retained record without its guest resolves special names again',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const host = await fixture.connectHost('orphan-record-host');
    const authority = harden({});
    await E(host).provideWorker('first-worker');
    const endowments = harden({ '@main': ['first-worker'] });
    await E(host).provideGuest('orphan-session', { authority, endowments });
    const policyPath = ['provisioned-guests', 'orphan-session', 'authority'];
    const current = /** @type {any} */ (await E(host).lookup(policyPath));
    // A record carrying identifiers (as an earlier shape did, or a forged
    // one) is not trusted for special names.
    await E(host).remove(...policyPath);
    await E(host).storeValue(
      harden({
        ...current,
        specialNames: { '@main': await E(host).identify('@agent') },
      }),
      policyPath,
    );
    // Lose the guest but keep the record, as an interrupted creation would.
    await E(host).remove('orphan-session');
    await E(host).remove('first-worker');

    await t.throwsAsync(
      E(host).provideGuest('orphan-session', { authority, endowments }),
      { message: /SPECIAL_NAME_SOURCE_UNAVAILABLE/ },
    );
    t.false(await E(host).has('orphan-session'));

    await E(host).provideWorker('first-worker');
    const recreated = await E(host).provideGuest('orphan-session', {
      authority,
      endowments,
    });
    t.is(
      await E(recreated).identify('@main'),
      await E(host).identify('first-worker'),
    );
  },
);

test.serial(
  'a handle held for another host guest cannot be endowed',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const owner = await fixture.connectHost('handle-owner-host');
    await E(owner).provideGuest('owned-guest');
    const sibling = await E(owner).provideHost('sibling', {
      introducedNames: { 'owned-guest': 'owned-guest' },
    });
    await E(sibling).provideWorker('sibling-worker');
    await t.throwsAsync(
      E(sibling).provideGuest('owned-guest', {
        endowments: { tool: ['sibling-worker'] },
      }),
      { message: /not a guest of this host/ },
    );

    // The owning host may still endow its guest through the handle name.
    await E(owner).provideWorker('owner-worker');
    await E(owner).provideGuest('owned-guest', {
      endowments: { tool: ['owner-worker'] },
    });
    const guestAgentId = await E(owner).identify('owned-guest');
    t.truthy(guestAgentId);
  },
);

test.serial(
  'retained authority written with introducedNames still reconnects',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const host = await fixture.connectHost('legacy-record-host');
    const authority = harden({});
    await E(host).provideWorker('legacy-tool');
    const toolId = await E(host).identify('legacy-tool');
    await E(host).provideGuest('legacy-session', {
      authority,
      endowments: { tool: ['legacy-tool'] },
    });
    const policyPath = ['provisioned-guests', 'legacy-session', 'authority'];
    const current = /** @type {any} */ (await E(host).lookup(policyPath));
    // The shape a daemon wrote before `endowments` replaced `introducedNames`.
    await E(host).remove(...policyPath);
    await E(host).storeValue(
      harden({
        policy: current.policy,
        credentialIds: current.credentialIds,
        introducedNames: { 'legacy-tool': 'tool' },
      }),
      policyPath,
    );

    const reconnected = await E(host).provideGuest('legacy-session');
    t.is(await E(reconnected).identify('tool'), toolId);
    const repeated = await E(host).provideGuest('legacy-session', {
      authority,
      endowments: { tool: ['legacy-tool'] },
    });
    t.is(await E(repeated).identify('tool'), toolId);
    await t.throwsAsync(
      E(host).provideGuest('legacy-session', {
        authority,
        endowments: { other: ['legacy-tool'] },
      }),
      { message: /cannot widen or change retained authority/ },
    );
  },
);

test.serial('an ordinary endowment may be named __proto__', async t => {
  t.timeout(120_000);
  const fixture = await makeProvisioningFixture(t);
  const host = await fixture.connectHost('proto-endowment-host');
  await E(host).provideWorker('proto-source');
  const sourceId = await E(host).identify('proto-source');
  const endowments = harden(
    Object.fromEntries([['__proto__', ['proto-source']]]),
  );

  const unretained = await E(host).provideGuest('proto-unretained', {
    endowments,
  });
  t.is(await E(unretained).identify('__proto__'), sourceId);

  const retained = await E(host).provideGuest('proto-retained', {
    authority: harden({}),
    endowments,
  });
  t.is(await E(retained).identify('__proto__'), sourceId);
});

test.serial(
  'guest authority fails closed at dependency and path boundaries',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const outside = join(fixture.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(fixture.workspace, 'escape'), 'dir');
    const host = await fixture.connectHost('authority-boundaries-host');

    const empty = await E(host).provideGuest('empty-authority', {
      authority: {},
    });
    t.false(await E(empty).has('workspace'));

    await t.throwsAsync(
      E(host).provideGuest('implicit-dependency', {
        authority: {
          git: { repo: { mount: 'workspace', path: [] } },
        },
      }),
      { message: /unavailable mount binding/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('write-bypass', {
        authority: {
          mount: { docs: { path: fixture.workspace, readOnly: true } },
          git: { repo: { mount: 'docs', path: [] } },
        },
      }),
      { message: /requires a writable selected mount/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('symlink-escape', {
        authority: {
          mount: { workspace: { path: fixture.workspace } },
          git: {
            repo: { mount: 'workspace', path: ['escape'], readOnly: true },
          },
        },
      }),
      { message: /escapes selected mount/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('remote-dependency', {
        authority: {
          gitRemote: {
            origin: {
              git: 'repo',
              name: 'origin',
              url: 'file:///tmp/remote.git',
            },
          },
        },
      }),
      { message: /unavailable Git binding/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('incompatible-agent-name', {
        agentName: 'different-agent-name',
        authority: {},
      }),
      { message: /agentName to match the host pet name/ },
    );
    const matchingAgentName = await E(host).provideGuest(
      'matching-agent-name',
      {
        agentName: 'matching-agent-name',
        authority: {},
      },
    );
    t.is(typeof (await E(matchingAgentName).help()), 'string');

    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: fixture.workspace,
    });
    const harmlessQueryRemote = join(fixture.root, 'harmless-query.git');
    await execFileAsync('git', ['init', '--bare', '-q', harmlessQueryRemote]);
    const harmlessQueryGuest = await E(host).provideGuest('harmless-query', {
      authority: {
        mount: { workspace: { path: fixture.workspace } },
        git: {
          repo: { mount: 'workspace', path: [] },
        },
        gitRemote: {
          origin: {
            git: 'repo',
            name: 'origin',
            url: `${new URL(`file://${harmlessQueryRemote}`).href}?password_policy=strict&token_count=2`,
            allowLocalFileTransport: true,
          },
        },
      },
    });
    t.true(await E(harmlessQueryGuest).has('origin'));
    await t.throwsAsync(
      E(host).provideGuest('embedded-remote-credential', {
        authority: {
          mount: { workspace: { path: fixture.workspace } },
          git: { repo: { mount: 'workspace', path: [] } },
          gitRemote: {
            origin: {
              git: 'repo',
              name: 'origin',
              url: 'https://user:password@example.test/repo.git',
            },
          },
        },
      }),
      { message: /must not (?:include embedded|embed) credentials/ },
    );

    const missingIntroduction = await E(host).provideGuest(
      'missing-introduction',
      {
        authority: {},
        endowments: { optionalTool: ['absent'] },
      },
    );
    t.false(await E(missingIntroduction).has('optionalTool'));
    await E(host).provideGuest('absent');
    const reappliedIntroduction = await E(host).provideGuest(
      'missing-introduction',
    );
    t.true(await E(reappliedIntroduction).has('optionalTool'));

    await t.throwsAsync(
      E(host).provideGuest('unknown-authority-field', {
        authority: {
          mounts: {},
        },
      }),
      { message: /provideGuest.*Must be|must not have properties:.*mounts/i },
    );
  },
);

test.serial(
  'retained authority pins host-owned credential identity',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: fixture.workspace,
    });
    const host = await fixture.connectHost('authority-credential-host');
    await E(host).makeDirectory(['credentials']);
    await E(host).provideBearerCredential(['credentials', 'origin'], {
      audience: 'https://example.test',
      token: 'first-test-token',
    });
    const authority = harden({
      mount: { workspace: { path: fixture.workspace } },
      git: { repo: { mount: 'workspace', path: [] } },
      gitRemote: {
        origin: {
          git: 'repo',
          name: 'origin',
          url: 'https://example.test/repository.git',
          credential: ['credentials', 'origin'],
        },
      },
    });
    await E(host).provideGuest('credential-session', { authority });

    await E(host).provideBearerCredential(['credentials', 'origin'], {
      audience: 'https://example.test',
      token: 'replacement-test-token',
    });
    await t.throwsAsync(
      E(host).provideGuest('credential-session', { authority }),
      { message: /cannot widen or change retained authority/ },
    );
  },
);

test.serial(
  'provideGuest endows an unretained guest through the same endowments map',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const host = await fixture.connectHost('unretained-endowment-host');
    await E(host).provideWorker('custom-worker');
    await E(host).makeDirectory(['tools']);
    await E(host).provideWorker(['tools', 'nested-worker']);
    const customId = await E(host).identify('custom-worker');
    const nestedId = await E(host).identify('tools', 'nested-worker');

    const guest = await E(host).provideGuest('plain-guest', {
      endowments: {
        '@main': ['custom-worker'],
        'host-agent': ['@agent'],
        nested: ['tools', 'nested-worker'],
        missing: ['absent'],
      },
    });
    t.is(await E(guest).identify('@main'), customId);
    t.is(
      await E(guest).identify('host-agent'),
      await E(host).identify('@agent'),
    );
    t.is(await E(guest).identify('nested'), nestedId);
    t.false(await E(guest).has('missing'));

    // Ordinary endowments may be (re)applied to an existing guest; special
    // endowments are indelible and may only be supplied at creation.
    await E(host).provideWorker('absent');
    await E(host).provideGuest('plain-guest', {
      endowments: { missing: ['absent'] },
    });
    t.is(await E(guest).identify('missing'), await E(host).identify('absent'));
    await t.throwsAsync(
      E(host).provideGuest('plain-guest', {
        endowments: { '@main': ['absent'] },
      }),
      { message: /cannot be added to an existing guest/ },
    );
    await t.throwsAsync(
      E(host).provideGuest('other-guest', {
        endowments: { '@main': ['nowhere'] },
      }),
      { message: /SPECIAL_NAME_SOURCE_UNAVAILABLE/ },
    );
    t.false(await E(host).has('other-guest'));
  },
);

test.serial('@main must be endowed with a worker', async t => {
  t.timeout(120_000);
  const fixture = await makeProvisioningFixture(t);
  const host = await fixture.connectHost('main-worker-host');
  await E(host).storeValue(harden({ not: 'a worker' }), 'inert-value');
  await t.throwsAsync(
    E(host).provideGuest('unretained-non-worker', {
      endowments: { '@main': ['inert-value'] },
    }),
    { message: /"@main" must name a worker/ },
  );
  t.false(await E(host).has('unretained-non-worker'));
  await t.throwsAsync(
    E(host).provideGuest('retained-non-worker', {
      authority: harden({}),
      endowments: { '@main': ['@agent'] },
    }),
    { message: /"@main" must name a worker/ },
  );
  t.false(await E(host).has('retained-non-worker'));
});

test.serial(
  'authority cannot attach special endowments to an existing unprovisioned guest',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const host = await fixture.connectHost('late-authority-host');
    await E(host).provideWorker('late-worker');
    const guest = await E(host).provideGuest('alice');
    const defaultMainId = await E(guest).identify('@main');
    await t.throwsAsync(
      E(host).provideGuest('alice', {
        authority: harden({}),
        endowments: { '@main': ['late-worker'] },
      }),
      { message: /cannot add authority to an existing unprovisioned guest/ },
    );
    // No policy record was retained, so the guest and the (absent) record
    // cannot disagree about @main.
    t.is(await E(guest).identify('@main'), defaultMainId);
    t.false(await E(host).has('provisioned-guests'));
  },
);

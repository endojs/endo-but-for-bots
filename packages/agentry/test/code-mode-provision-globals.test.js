// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/pass-style';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { normalizeGlobals } from '@endo/agent-tools/code-mode/declarations.js';

import { makeCodeModeSystemPrompt } from '../src/code-mode.js';
import {
  makeEndoProvisionGlobals,
  makeEndoProvisionGrants,
} from '../src/code-mode-provision-globals.js';
import { registerProvisionedGuest } from '../src/code-mode-grants.js';

/** @param {Record<string, unknown>} policy */
const makePersistence = policy =>
  harden(
    /** @type {any} */ ({
      version: 2,
      guestHandlePath: ['code-mode', 'test', 'session-test', 'guest-handle'],
      workspacePath: '/workspace',
      policy: {
        mounts: {},
        ...policy,
      },
    }),
  );

test('globals match filesystem and Git authority modes', t => {
  const cases = [
    [makePersistence({}), []],
    [
      makePersistence({
        mounts: {
          workspace: {
            root: '/workspace',
            mode: 'readOnly',
            deniedSegments: [],
            guestBinding: true,
          },
        },
      }),
      normalizeGlobals([{ name: 'workspace' }]),
    ],
    [
      makePersistence({
        mounts: {
          workspace: {
            root: '/workspace',
            mode: 'readWrite',
            deniedSegments: [],
            guestBinding: true,
          },
        },
      }),
      normalizeGlobals([{ name: 'workspace' }]),
    ],
    [
      makePersistence({
        gits: {
          git: {
            mount: 'workspace',
            path: [],
            root: '/workspace',
            mode: 'readOnly',
          },
        },
      }),
      [makeGitGlobal({ name: 'git', readOnly: true })],
    ],
    [
      makePersistence({
        gits: {
          git: {
            mount: 'workspace',
            path: [],
            root: '/workspace',
            mode: 'readWrite',
          },
        },
      }),
      [makeGitGlobal({ name: 'git' })],
    ],
    [
      makePersistence({
        gits: {
          git: {
            mount: 'workspace',
            path: [],
            root: '/workspace',
            mode: 'historyRewrite',
          },
        },
      }),
      [makeGitGlobal({ name: 'git', historyRewrite: true })],
    ],
    [
      makePersistence({
        mounts: {
          workspace: {
            root: '/workspace',
            mode: 'readWrite',
            deniedSegments: [],
            guestBinding: true,
          },
        },
        gits: {
          git: {
            mount: 'workspace',
            path: [],
            root: '/workspace',
            mode: 'historyRewrite',
          },
        },
      }),
      [
        ...normalizeGlobals([{ name: 'workspace' }]),
        makeGitGlobal({ name: 'git', historyRewrite: true }),
      ],
    ],
  ];

  for (const [persistence, expected] of cases) {
    t.deepEqual(
      makeEndoProvisionGlobals(/** @type {any} */ (persistence)),
      expected,
    );
  }
});

test('remote globals are sorted and hardened', t => {
  const globals = makeEndoProvisionGlobals(
    makePersistence({
      gits: {
        git: {
          mount: 'workspace',
          path: [],
          root: '/workspace',
          mode: 'readWrite',
        },
      },
      gitRemotes: {
        zebra: {},
        alpha: {},
      },
    }),
  );

  t.deepEqual(globals, [
    makeGitGlobal({ name: 'git' }),
    ...normalizeGlobals([{ name: 'alpha' }, { name: 'zebra' }]),
  ]);
  t.true(Object.isFrozen(globals));
  t.true(globals.every(Object.isFrozen));
});

test('named Git globals each appear in the system prompt', t => {
  const globals = makeEndoProvisionGlobals(
    makePersistence({
      gits: {
        zeta: {
          mount: 'workspace',
          path: ['zeta'],
          root: '/workspace/zeta',
          mode: 'historyRewrite',
        },
        ebfb: {
          mount: 'workspace',
          path: ['ebfb'],
          root: '/workspace/ebfb',
          mode: 'readWrite',
        },
        inspect: {
          mount: 'workspace',
          path: ['inspect'],
          root: '/workspace/inspect',
          mode: 'readOnly',
        },
      },
    }),
  );

  t.deepEqual(
    globals.map(({ name }) => name),
    ['ebfb', 'inspect', 'zeta'],
  );
  const prompt = makeCodeModeSystemPrompt(globals);
  t.true(prompt.includes('declare const ebfb: WritableEndoGit;'));
  t.true(prompt.includes('declare const inspect: ReadOnlyEndoGit;'));
  t.true(prompt.includes('declare const zeta: EndoGitHistory;'));
});

test('guest-bound mounts remain untyped until their live capability is rebound', t => {
  const [readOnly] = makeEndoProvisionGlobals(
    makePersistence({
      mounts: {
        workspace: {
          root: '/workspace',
          mode: 'readOnly',
          deniedSegments: [],
          guestBinding: true,
        },
      },
    }),
  );
  const [writable] = makeEndoProvisionGlobals(
    makePersistence({
      mounts: {
        workspace: {
          root: '/workspace',
          mode: 'readWrite',
          deniedSegments: [],
          guestBinding: true,
        },
      },
    }),
  );

  t.deepEqual(readOnly, normalizeGlobals([{ name: 'workspace' }])[0]);
  t.deepEqual(writable, normalizeGlobals([{ name: 'workspace' }])[0]);
});

test('writable Git declaration discloses its writable worktree reach', t => {
  // F3: a writable Git grant with `fs` omitted reaches writable worktree files
  // through `worktree()` / `filesystemAt()`. The generated declaration the
  // guest reads already surfaces both verbs and their writable return types, so
  // the reach is discoverable without adding a separate filesystem global.
  const globals = makeEndoProvisionGlobals(
    makePersistence({
      gits: {
        git: {
          mount: 'workspace',
          path: [],
          root: '/workspace',
          mode: 'readWrite',
        },
      },
    }),
  );
  const prompt = makeCodeModeSystemPrompt(globals);
  t.true(prompt.includes('declare const git: WritableEndoGit;'));
  t.true(prompt.includes('worktree: () => Promise<GitWritableGitWorktree>;'));
  t.true(
    prompt.includes(
      'filesystemAt: (ref: GitRef | string) => Promise<GitFilesystem>;',
    ),
  );
});

test('named mount and Git globals expose only named capabilities', t => {
  const globals = makeEndoProvisionGlobals(
    makePersistence({
      mounts: {
        destination: {
          root: '/sibling',
          mode: 'readWrite',
          deniedSegments: [],
          guestBinding: true,
        },
        source: {
          root: '/workspace',
          mode: 'readOnly',
          deniedSegments: [],
          guestBinding: true,
        },
      },
      gits: {
        inspect: {
          mount: 'source',
          path: [],
          root: '/workspace',
          mode: 'readOnly',
        },
      },
    }),
  );

  t.deepEqual(
    globals.map(({ name }) => name),
    ['destination', 'source', 'inspect'],
  );
  const prompt = makeCodeModeSystemPrompt(globals);
  t.false(prompt.includes('/workspace'));
  t.false(prompt.includes('/sibling'));
});

test('retained grants reject a guest without trusted provisioning provenance', async t => {
  const workspace = Far('Workspace', {});
  const git = Far('Git', {});
  const guest = Far('Guest', {
    lookup: async name => (name === 'workspace' ? workspace : git),
  });
  const persistence = makePersistence({
    mounts: {
      workspace: {
        root: '/workspace',
        mode: 'readOnly',
        deniedSegments: [],
        guestBinding: true,
      },
    },
    gits: {
      git: {
        mount: 'workspace',
        path: [],
        root: '/workspace',
        mode: 'readOnly',
      },
    },
  });

  await t.throwsAsync(
    () =>
      makeEndoProvisionGrants(
        /** @type {any} */ (guest),
        /** @type {any} */ (persistence),
      ),
    {
      message: /guest returned by the trusted provisioning path/,
    },
  );
});

test('trusted provisioning provenance derives grants from the rebound guest', async t => {
  const workspace = Far('Workspace', {});
  const git = Far('Git', {});
  const guest = Far('Guest', {
    lookup: async name => (name === 'workspace' ? workspace : git),
  });
  const persistence = makePersistence({
    mounts: {
      workspace: {
        root: '/workspace',
        mode: 'readOnly',
        deniedSegments: [],
        guestBinding: true,
      },
    },
    gits: {
      git: {
        mount: 'workspace',
        path: [],
        root: '/workspace',
        mode: 'readOnly',
      },
    },
  });

  registerProvisionedGuest(guest);
  const grants = await makeEndoProvisionGrants(
    /** @type {any} */ (guest),
    /** @type {any} */ (persistence),
  );
  t.deepEqual(
    grants.map(({ name, declaration }) => ({ name, declaration })),
    [
      {
        name: 'workspace',
        declaration: { body: 'unknown' },
      },
      {
        name: 'git',
        declaration: makeGitGlobal({ name: 'git', readOnly: true }).declaration,
      },
    ],
  );
  t.is(grants[0].capability, workspace);
  t.is(grants[1].capability, git);
  t.true(Object.isFrozen(grants));
  t.true(grants.every(Object.isFrozen));
});

test('named provisioned grants receive opaque minter declarations', async t => {
  const calendar = Far('Calendar', {});
  const guest = Far('Guest', {
    lookup: async name => calendar,
  });
  const persistence = makePersistence({
    grants: {
      calendar: {
        from: ['tools', 'calendar'],
        description: 'A calendar service',
      },
    },
  });

  registerProvisionedGuest(guest);
  const [grant] = await makeEndoProvisionGrants(
    /** @type {any} */ (guest),
    /** @type {any} */ (persistence),
  );
  t.is(grant.name, 'calendar');
  t.deepEqual(grant.declaration, { body: 'unknown' });
  t.is(grant.description, 'A calendar service');
  t.is(grant.capability, calendar);
});

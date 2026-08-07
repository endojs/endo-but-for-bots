// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';

import { makeGitHistoryTool, makeGitTool } from '../src/json-tools/git.js';

/** @import { ERef } from '@endo/eventual-send' */
/**
 * @import {
 *   GitToolFacet,
 *   GitToolRewriterCapability,
 * } from '../src/types.js'
 */

/**
 * The catalog `makeGitTool` derives per facet: cumulative, matching
 * `@endo/exo-git`'s reader-within-writer-within-rewriter membership.
 *
 * @type {Record<GitToolFacet, string[]>}
 */
const SLICE_BY_FACET = {
  reader: [
    'log',
    'diff',
    'show',
    'branches',
    'currentBranch',
    'trackingStatus',
  ],
  writer: [
    'log',
    'diff',
    'show',
    'commit',
    'branches',
    'createBranch',
    'switchBranch',
    'currentBranch',
    'trackingStatus',
  ],
  rewriter: [
    'log',
    'diff',
    'show',
    'commit',
    'reword',
    'cherryPick',
    'rebase',
    'branches',
    'createBranch',
    'switchBranch',
    'currentBranch',
    'trackingStatus',
  ],
};

/**
 * Stub Git capability that records the method name and positional args. A
 * single stub carrying every rewriter-tier method is structurally a valid
 * reader/writer/rewriter capability (each `GitTool*Capability` is a `Pick` of
 * this same shape), so one stub exercises `makeGitTool` at every facet.
 *
 * @param {unknown[][]} calls An array each call appends its `[name, ...args]` to.
 * @returns {ERef<GitToolRewriterCapability>}
 */
const makeStubGit = calls => {
  /** @type {GitToolRewriterCapability} */
  const stubGit = {
    log: async (...a) => {
      calls.push(['log', ...a]);
      return [];
    },
    diff: async (...a) => {
      calls.push(['diff', ...a]);
      return '';
    },
    show: async (...a) => {
      calls.push(['show', ...a]);
      return '';
    },
    commit: async (...a) => {
      calls.push(['commit', ...a]);
      return { oid: 'x', summary: a[0] };
    },
    reword: async (...a) => {
      calls.push(['reword', ...a]);
      return { oid: 'x', summary: a[1] };
    },
    cherryPick: async (...a) => {
      calls.push(['cherryPick', ...a]);
      return '';
    },
    rebase: async (...a) => {
      calls.push(['rebase', ...a]);
      return '';
    },
    branches: async (...a) => {
      calls.push(['branches', ...a]);
      return [];
    },
    createBranch: async (...a) => {
      calls.push(['createBranch', ...a]);
      return { name: a[0], kind: 'branch' };
    },
    switchBranch: async (...a) => {
      calls.push(['switchBranch', ...a]);
    },
    currentBranch: async (...a) => {
      calls.push(['currentBranch', ...a]);
      return undefined;
    },
    trackingStatus: async (...a) => {
      calls.push(['trackingStatus', ...a]);
      return { ahead: 0, behind: 0, detached: true };
    },
  };
  return Far('StubGit', stubGit);
};

test('makeGitTool derives its catalog from the granted facet', t => {
  for (const facet of /** @type {GitToolFacet[]} */ (
    Object.keys(SLICE_BY_FACET)
  )) {
    const tools = makeGitTool(
      /** @type {any} */ (makeStubGit([])),
      /** @type {any} */ ({ facet }),
    );
    const names = tools.map(tool => tool.name).sort();
    t.deepEqual(names, [...SLICE_BY_FACET[facet]].sort(), `facet: ${facet}`);
    for (const tool of tools) {
      t.is(typeof tool.description, 'string');
      t.truthy(tool.parameters);
      t.is(tool.inputSchema, tool.parameters);
      t.is(typeof tool.invoke, 'function');
    }
  }
});

test('makeGitTool defaults to the writer facet when no options are given', t => {
  const tools = makeGitTool(/** @type {any} */ (makeStubGit([])));
  const names = tools.map(tool => tool.name).sort();
  t.deepEqual(names, [...SLICE_BY_FACET.writer].sort());
});

test('makeGitTool omits cap-heavy methods at every facet', t => {
  for (const facet of /** @type {GitToolFacet[]} */ (
    Object.keys(SLICE_BY_FACET)
  )) {
    const tools = makeGitTool(
      /** @type {any} */ (makeStubGit([])),
      /** @type {any} */ ({ facet }),
    );
    const names = new Set(tools.map(tool => tool.name));
    t.false(names.has('status'), `facet: ${facet}`);
    t.false(names.has('add'), `facet: ${facet}`);
    t.false(names.has('restore'), `facet: ${facet}`);
    t.false(names.has('filesystemAt'), `facet: ${facet}`);
  }
});

test('the writer facet rejects commit amend before reaching the capability', async t => {
  const tools = makeGitTool(/** @type {any} */ (makeStubGit([])));
  const commit = tools.find(tool => tool.name === 'commit');
  if (!commit) throw new Error('no commit tool');
  await null;
  await t.throwsAsync(
    commit.invoke({ message: 'not an amendment', options: { amend: true } }),
    { message: /options/ },
  );
});

test('invoke marshals named args to positional and calls the capability at the writer facet', async t => {
  const calls = [];
  const tools = makeGitTool(/** @type {any} */ (makeStubGit(calls)));
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  await null;

  await byName('commit').invoke({ message: 'a message' });
  await byName('createBranch').invoke({ name: 'feature' });
  await byName('createBranch').invoke({ name: 'feature', options: harden({}) });
  await byName('log').invoke({});

  t.deepEqual(calls, [
    ['commit', 'a message'],
    ['createBranch', 'feature'],
    ['createBranch', 'feature', {}],
    ['log'],
  ]);
});

test('invoke marshals named args to positional and calls the capability at the rewriter facet', async t => {
  const calls = [];
  const tools = makeGitTool(
    /** @type {any} */ (makeStubGit(calls)),
    /** @type {any} */ ({ facet: 'rewriter' }),
  );
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  await null;

  await byName('commit').invoke({
    message: 'amended message',
    options: harden({ amend: true }),
  });
  await byName('reword').invoke({ ref: 'HEAD~1', message: 'new subject' });
  await byName('cherryPick').invoke({ ref: 'side' });
  await byName('cherryPick').invoke({
    ref: 'side',
    options: harden({ noCommit: true }),
  });
  await byName('rebase').invoke({
    input: harden({ mode: 'start', upstream: 'main', autosquash: true }),
  });

  t.deepEqual(calls, [
    ['commit', 'amended message', { amend: true }],
    ['reword', 'HEAD~1', 'new subject'],
    ['cherryPick', 'side'],
    ['cherryPick', 'side', { noCommit: true }],
    ['rebase', { mode: 'start', upstream: 'main', autosquash: true }],
  ]);
});

test('invoke rejects an arg that violates the runtime guard', async t => {
  const tools = makeGitTool(/** @type {any} */ (makeStubGit([])));
  const commit = tools.find(tool => tool.name === 'commit');
  if (!commit) throw new Error('no commit tool');
  await null;
  await t.throwsAsync(() => commit.invoke({ message: 123 }));
});

test('the schemas advertise real, declarative property names', t => {
  const tools = makeGitTool(
    /** @type {any} */ (makeStubGit([])),
    /** @type {any} */ ({ facet: 'rewriter' }),
  );
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };
  const propsOf = name =>
    Object.keys(
      /** @type {{ properties?: object }} */ (byName(name).parameters)
        .properties || {},
    );

  // No method advertises the generic `argN` convention any more.
  for (const tool of tools) {
    const props = Object.keys(
      /** @type {{ properties?: object }} */ (tool.parameters).properties || {},
    );
    for (const prop of props) {
      t.false(
        /^arg\d+$/.test(prop),
        `${tool.name} should not advertise a generic argN property; got ${prop}`,
      );
    }
  }

  t.deepEqual(propsOf('commit'), ['message', 'options']);
  t.deepEqual(propsOf('reword'), ['ref', 'message']);
  t.deepEqual(propsOf('cherryPick'), ['ref', 'options']);
  t.deepEqual(propsOf('rebase'), ['input']);
  t.deepEqual(propsOf('show'), ['ref']);
  t.deepEqual(propsOf('createBranch'), ['name', 'options']);
  t.deepEqual(propsOf('switchBranch'), ['branch']);
  t.deepEqual(propsOf('log'), ['options']);
  t.deepEqual(propsOf('diff'), ['options']);
});

test('makeGitHistoryTool preserves its four-tool order from the canonical rewriter catalog', t => {
  const git = makeStubGit([]);
  const historyTools = makeGitHistoryTool(git);
  const rewriterTools = makeGitTool(git, { facet: 'rewriter' });
  const rewriterByName = new Map(rewriterTools.map(tool => [tool.name, tool]));

  t.deepEqual(
    historyTools.map(tool => tool.name),
    ['commit', 'reword', 'cherryPick', 'rebase'],
  );
  for (const historyTool of historyTools) {
    const rewriterTool = rewriterByName.get(historyTool.name);
    if (!rewriterTool) {
      throw new Error(`rewriter catalog has no ${historyTool.name} tool`);
    }
    t.is(historyTool.description, rewriterTool.description);
    t.is(historyTool.parameters, rewriterTool.parameters);
  }
});

test('history composition does not duplicate ordinary-only writer tools', t => {
  const git = makeStubGit([]);
  const writerNames = makeGitTool(git).map(tool => tool.name);
  const historyNames = makeGitHistoryTool(git).map(tool => tool.name);
  const overlaps = writerNames.filter(name => historyNames.includes(name));

  // `commit` is the compatibility inventory's intentional historical overlap:
  // the history form carries amend. No reader/navigation or branch-edit tool
  // is repeated when a host composes the two catalogs.
  t.deepEqual(overlaps, ['commit']);
});

test('invoke resolves named args by their real property names', async t => {
  const calls = [];
  const tools = makeGitTool(
    /** @type {any} */ (makeStubGit(calls)),
    /** @type {any} */ ({ facet: 'rewriter' }),
  );
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  await null;

  await byName('show').invoke({ ref: 'HEAD' });
  await byName('cherryPick').invoke({ ref: { name: 'HEAD', kind: 'commit' } });
  await byName('switchBranch').invoke({ branch: 'feature' });
  await byName('log').invoke({ options: harden({ maxCount: 3 }) });

  t.deepEqual(calls, [
    ['show', 'HEAD'],
    ['cherryPick', { name: 'HEAD', kind: 'commit' }],
    ['switchBranch', 'feature'],
    ['log', { maxCount: 3 }],
  ]);
});

test('rebase JSON tool dispatches start and every control mode', async t => {
  const calls = [];
  const tools = makeGitTool(
    /** @type {any} */ (makeStubGit(calls)),
    /** @type {any} */ ({ facet: 'rewriter' }),
  );
  const rebase = tools.find(tool => tool.name === 'rebase');
  if (!rebase) throw new Error('no rebase tool');

  await null;

  await rebase.invoke({ input: { mode: 'start', upstream: 'main' } });
  await rebase.invoke({
    input: { mode: 'start', upstream: 'main', autosquash: true },
  });
  await rebase.invoke({ input: { mode: 'continue' } });
  await rebase.invoke({ input: { mode: 'abort' } });
  await rebase.invoke({ input: { mode: 'skip' } });

  t.deepEqual(calls, [
    ['rebase', { mode: 'start', upstream: 'main' }],
    ['rebase', { mode: 'start', upstream: 'main', autosquash: true }],
    ['rebase', { mode: 'continue' }],
    ['rebase', { mode: 'abort' }],
    ['rebase', { mode: 'skip' }],
  ]);
});

test('rebase JSON tool guard rejects fields on the wrong mode', async t => {
  const calls = [];
  const tools = makeGitTool(
    /** @type {any} */ (makeStubGit(calls)),
    /** @type {any} */ ({ facet: 'rewriter' }),
  );
  const rebase = tools.find(tool => tool.name === 'rebase');
  if (!rebase) throw new Error('no rebase tool');

  await null;

  const invalidInputs = [
    { mode: 'start' },
    { mode: 'continue', upstream: 'main' },
    { mode: 'abort', autosquash: true },
    { mode: 'skip', autosquash: false },
    { mode: 'finish' },
  ];
  const errors = await Promise.all(
    invalidInputs.map(input => t.throwsAsync(() => rebase.invoke({ input }))),
  );
  for (let index = 0; index < invalidInputs.length; index += 1) {
    const input = invalidInputs[index];
    const err = errors[index];
    t.true(
      err !== undefined && err.message.includes('rebase input'),
      `error should name rebase input for ${JSON.stringify(input)}; got: ${
        err?.message
      }`,
    );
  }
  t.deepEqual(calls, []);
});

test('rebase descriptions explain modes and stopped-conflict recovery', t => {
  const tools = makeGitTool(makeStubGit([]), { facet: 'rewriter' });
  const rebase = tools.find(tool => tool.name === 'rebase');
  if (!rebase) throw new Error('no rebase tool');
  const input = /** @type {{ description?: string }} */ (
    /** @type {{ properties: { input: object } }} */ (rebase.parameters)
      .properties.input
  );

  for (const phrase of ['start', 'continue', 'abort', 'skip', 'conflicts']) {
    t.true(rebase.description.includes(phrase));
    t.true(input.description?.includes(phrase));
  }
});

test('invoke rejects a wrong property name and a missing required one', async t => {
  const tools = makeGitTool(/** @type {any} */ (makeStubGit([])));
  const byName = name => {
    const found = tools.find(tool => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  await null;

  // The legacy `arg0` key is no longer accepted; `commit` wants `message`.
  const wrongName = await t.throwsAsync(() =>
    byName('commit').invoke({ arg0: 'a message' }),
  );
  t.true(
    wrongName !== undefined && wrongName.message.includes('arg0'),
    `error should name the offending key; got: ${wrongName?.message}`,
  );

  // Omitting the required `message` is rejected before the capability is hit.
  const missing = await t.throwsAsync(() => byName('commit').invoke({}));
  t.true(
    missing !== undefined && missing.message.includes('message'),
    `error should name the missing required key; got: ${missing?.message}`,
  );
});

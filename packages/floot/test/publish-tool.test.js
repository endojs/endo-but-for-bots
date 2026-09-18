// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makePublishTool } from '../src/publish-tool.js';

const makeAssetServer = () => {
  const served = [];
  const revoked = [];
  const standing = new Map();
  const unavailable = new Set();
  const failRelease = { count: 0 };
  let counter = 0;
  const server = Far('AssetPublisher', {
    async serve(target, options = {}) {
      // The real server classifies what it is handed — Filesystem, Mount or
      // Git workspace — takes its own read-only facet, and refuses the rest;
      // mirror the refusal, so a regression fails here rather than in
      // production.
      // eslint-disable-next-line no-underscore-dangle
      const names = await E(target).__getMethodNames__();
      if (
        !names.includes('root') &&
        !names.includes('worktree') &&
        !names.includes('lookup')
      ) {
        throw Error('serve requires a Filesystem, Mount or Git capability');
      }
      // A caller-chosen id that already stands is the same route.
      if (options.id !== undefined && standing.has(options.id)) {
        const again = standing.get(options.id);
        return harden({ id: options.id, path: '/again/', url: again, revoke: undefined });
      }
      counter += 1;
      const id = options.id ?? `${counter}`.padStart(32, '0');
      const url = `http://host/token-${counter}/`;
      served.push({ target, url, label: options.label, id });
      standing.set(id, url);
      const revoke = Far('AssetMount', {
        async revoke() {
          standing.delete(id);
          revoked.push(url);
        },
      });
      return harden({ id, path: `/token-${counter}/`, url, revoke });
    },
    async describe(id) {
      return standing.has(id)
        ? harden({
            id,
            url: standing.get(id),
            status: unavailable.has(id) ? 'unavailable' : 'ready',
          })
        : undefined;
    },
    async check(id) {
      return server.describe(id);
    },
    async release(id) {
      if (failRelease.count > 0) {
        failRelease.count -= 1;
        throw Error('store is unreachable');
      }
      if (!standing.has(id)) return false;
      revoked.push(standing.get(id));
      standing.delete(id);
      return true;
    },
  });
  // What a restart of an in-memory server, or an administrator, does.
  const forget = () => standing.clear();
  return { server, served, revoked, forget, unavailable, standing, failRelease };
};

const INDEX = 'index.html';

/** A Mount child shaped like a MountFile: `text` is what marks it a file. */
const makeMountFile = () =>
  Far('MountFile', {
    text: async () => '<!doctype html>',
    streamBase64: () => undefined,
  });

/** @param {string | string[]} path */
const lastSegment = path =>
  Array.isArray(path) ? path[path.length - 1] : path;

/** @param {boolean} withIndex */
const makeMountLookup = withIndex => path => {
  if (withIndex && lastSegment(path) === INDEX) return makeMountFile();
  throw Error('ENOENT: no such file or directory');
};

/** A cap shaped like an endo-fs Filesystem: served as-is.
 * @param {{ withIndex?: boolean }} [options] */
const makeFilesystemCap = ({ withIndex = true } = {}) =>
  Far('Filesystem', {
    root: () =>
      Far('Directory', {
        lookup: name => {
          if (withIndex && lastSegment(name) === INDEX) {
            return Far('File', { open: () => undefined });
          }
          throw Error('ENOENT');
        },
      }),
    statfs: () => harden({}),
  });

/**
 * A cap shaped like an `@endo/exo-git` workspace. `readOnly()` and
 * `worktree()` are the projection path; nothing walks the returned Mount here,
 * so it only has to classify.
 */
const makeGitCap = ({ withIndex = true } = {}) => {
  const mount = Far('EndoMount', {
    kind: () => 'directory',
    lookup: makeMountLookup(withIndex),
    list: () => harden(withIndex ? [INDEX] : []),
  });
  const readOnlyGit = Far('Git', {
    worktree: () => mount,
    status: () => harden({}),
    commit: () => '',
  });
  return {
    mount,
    git: Far('Git', {
      readOnly: () => readOnlyGit,
      worktree: () => mount,
      status: () => harden({}),
      commit: () => '',
    }),
  };
};

/** A cap shaped like an `@endo/daemon` Mount. */
const makeMountCap = ({ withIndex = true } = {}) => {
  const readOnlyTree = Far('ReadableTree', {
    kind: () => 'directory',
    lookup: makeMountLookup(withIndex),
    list: () => harden(withIndex ? [INDEX] : []),
  });
  return Far('EndoMount', {
    kind: () => 'directory',
    lookup: makeMountLookup(withIndex),
    list: () => harden(withIndex ? [INDEX] : []),
    makeDirectory: () => undefined,
    readOnly: () => readOnlyTree,
  });
};

test('publishWorkspace serves the workspace and returns its capability URL', async t => {
  const asset = makeAssetServer();
  const workspace = makeFilesystemCap();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => workspace,
  });

  t.is(tool.schema().function.name, 'publishWorkspace');
  const result = await E(tool).execute({});
  t.regex(result, /http:\/\/host\/token-1\//);
  t.is(asset.served.length, 1);
  // The workspace cap itself is handed over: the server takes its own
  // read-only facet of it and retains that.
  t.is(asset.served[0].target, workspace);
});

test('a git workspace is handed to the server as the durable cap it is', async t => {
  // The server retains what it serves, and it can only retain a cap the
  // daemon minted: the session's `git-workspace` object, not a view of it
  // built in this worker, which would not outlive the worker. The projection
  // here is only the check that the root resolves.
  const asset = makeAssetServer();
  const { git } = makeGitCap();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => git,
    label: 'floot session s1',
  });

  const result = await E(tool).execute({});
  t.regex(result, /http:\/\/host\/token-1\//);
  t.is(asset.served.length, 1);
  t.is(asset.served[0].target, git);
  t.is(asset.served[0].label, 'floot session s1');
});

test('a Mount workspace is handed over as it is, too', async t => {
  const asset = makeAssetServer();
  const mount = makeMountCap();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => mount,
  });

  await E(tool).execute({});
  t.is(asset.served.length, 1);
  t.is(asset.served[0].target, mount);
});

test('an unservable workspace is reported, not served', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => Far('Opaque', { help: () => '' }),
  });

  const result = await E(tool).execute({});
  t.regex(result, /Publishing failed/);
  t.regex(result, /not a Filesystem, Mount, or Git/);
  t.is(asset.served.length, 0, 'nothing was mounted');
});

test('a failed projection leaves the previous publication serving', async t => {
  // dropCurrent() must not run before the new filesystem is in hand, or a
  // publish that cannot project would revoke a working URL and replace it
  // with nothing.
  const asset = makeAssetServer();
  /** @type {any} */
  let workspace = makeFilesystemCap();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => workspace,
  });

  t.regex(await E(tool).execute({}), /token-1/);
  workspace = Far('Opaque', { help: () => '' });
  t.regex(await E(tool).execute({}), /Publishing failed/);
  t.deepEqual(asset.revoked, [], 'the working mount was not revoked');
});

test('publishing again reports the standing URL and mints nothing', async t => {
  // The served tree is the live workspace, so a second publish has nothing
  // to refresh; a second URL for the same files would be one more route to
  // leak.
  const asset = makeAssetServer();
  const workspace = makeFilesystemCap();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => workspace,
  });

  const first = await E(tool).execute({});
  const second = await E(tool).execute({});
  t.is(first, second);
  t.is(asset.served.length, 1);
  t.deepEqual(asset.revoked, []);
});

test('the publication is the session’s: a rebuilt tool finds it, and only deletion releases it', async t => {
  const asset = makeAssetServer();
  /** @type {any} */
  let recorded;
  const make = () =>
    makePublishTool({
      getAssetServer: async () => asset.server,
      getWorkspace: async () => makeFilesystemCap(),
      loadPublication: async () => recorded,
      savePublication: async publication => {
        recorded = publication;
      },
      makeId: () => 'a'.repeat(32),
    });

  t.regex(await E(make()).execute({}), /token-1/);
  t.deepEqual(recorded, { id: 'a'.repeat(32), url: 'http://host/token-1/' });
  // A new instance — a revived agent, a restarted daemon — serves nothing.
  const rebuilt = make();
  t.regex(await E(rebuilt).execute({}), /token-1/);
  t.is(asset.served.length, 1);
  t.deepEqual(asset.revoked, []);

  await rebuilt.revoke();
  t.deepEqual(asset.revoked, ['http://host/token-1/']);
  t.is(recorded, undefined);
  await rebuilt.revoke();
  t.is(asset.revoked.length, 1, 'idempotent');
});

test('a publication the server no longer has is served again', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeFilesystemCap(),
  });
  t.regex(await E(tool).execute({}), /token-1/);
  asset.forget();
  t.regex(await E(tool).execute({}), /token-2/);
  t.is(asset.served.length, 2);
});

test('the id is recorded before anything is served, so a crash in between loses nothing', async t => {
  const asset = makeAssetServer();
  /** @type {any[]} */
  const saves = [];
  /** @type {any} */
  let recorded;
  const make = options =>
    makePublishTool({
      getAssetServer: async () => asset.server,
      getWorkspace: async () => makeFilesystemCap(),
      loadPublication: async () => recorded,
      savePublication: async publication => {
        saves.push({ publication, servedSoFar: asset.served.length });
        recorded = publication;
      },
      makeId: () => 'b'.repeat(32),
      ...options,
    });

  await E(make()).execute({});
  t.deepEqual(saves[0], {
    publication: { id: 'b'.repeat(32), pending: true },
    servedSoFar: 0,
  });

  // The crash: the server has the route, the record still says pending.
  recorded = { id: 'b'.repeat(32), pending: true };
  t.regex(await E(make()).execute({}), /token-1/);
  t.is(asset.served.length, 1, 'found by its id, not served again');
  t.deepEqual(recorded, { id: 'b'.repeat(32), url: 'http://host/token-1/' });

  // The other crash: recorded pending, never served. Same id, served now.
  asset.forget();
  recorded = { id: 'b'.repeat(32), pending: true };
  t.regex(await E(make()).execute({}), /token-2/);
  t.is(asset.served.at(-1).id, 'b'.repeat(32));
});

test('a publication that cannot be recorded serves nothing', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeFilesystemCap(),
    loadPublication: async () => undefined,
    savePublication: async () => {
      throw Error('registry is read-only');
    },
  });
  t.regex(await E(tool).execute({}), /could not be recorded/);
  t.is(asset.served.length, 0);
});

test('a standing route whose target no longer answers is replaced', async t => {
  const asset = makeAssetServer();
  let next = 0;
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeFilesystemCap(),
    makeId: () => `${(next += 1)}`.repeat(32),
  });
  t.regex(await E(tool).execute({}), /token-1/);
  asset.unavailable.add('1'.repeat(32));
  t.regex(await E(tool).execute({}), /token-2/);
  t.deepEqual(asset.revoked, ['http://host/token-1/']);
});

test('publishes of one session share a chain across tool instances', async t => {
  const asset = makeAssetServer();
  /** @type {any} */
  let recorded;
  let chain = Promise.resolve();
  const serialize = thunk => {
    const run = chain.then(thunk, thunk);
    chain = run.catch(() => {});
    return run;
  };
  const make = () =>
    makePublishTool({
      getAssetServer: async () => asset.server,
      getWorkspace: async () => makeFilesystemCap(),
      loadPublication: async () => recorded,
      savePublication: async publication => {
        recorded = publication;
      },
      serialize,
    });
  // An old instance and a rebuilt one, both publishing at once.
  const [first, second] = await Promise.all([
    E(make()).execute({}),
    E(make()).execute({}),
  ]);
  t.is(first, second);
  t.is(asset.served.length, 1);
});

test('revoke() releases the served route on session teardown', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeFilesystemCap(),
  });
  await E(tool).execute({});
  await tool.revoke();
  t.deepEqual(asset.revoked, ['http://host/token-1/']);
});

test('with no workspace, publishWorkspace explains rather than serving', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => undefined,
  });
  const result = await E(tool).execute({});
  t.regex(result, /no project workspace/i);
  t.is(asset.served.length, 0);
});

test('the asset server is resolved per publish, so a late binding is found', async t => {
  // The hosted setup binds the server after the factory is up; a session
  // opened before that still publishes once it is there, and the tool is
  // present (with a stable schema) the whole time.
  const asset = makeAssetServer();
  let bound = false;
  const tool = makePublishTool({
    getAssetServer: async () => (bound ? asset.server : undefined),
    getWorkspace: async () => makeFilesystemCap(),
  });
  const unavailable = await E(tool).execute({});
  t.regex(unavailable, /unavailable/i);
  t.is(asset.served.length, 0);
  bound = true;
  t.regex(await E(tool).execute({}), /http:\/\/host\/token-1\//);
});

test('concurrent publishes serialize into one route', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeFilesystemCap(),
  });
  // Both start before either resolves. Unserialized, each would find no
  // publication, serve its own, and only the last would be recorded — the
  // first never released.
  const first = E(tool).execute({});
  const second = E(tool).execute({});
  t.is(await first, await second);
  t.is(asset.served.length, 1);
  await tool.revoke();
  t.deepEqual(asset.revoked, ['http://host/token-1/']);
});

test('a workspace with no readable index is refused, not published', async t => {
  // The failure this closes: a backend whose slice writes somewhere other than
  // the session's workspace leaves an empty worktree here, and publishing it
  // returned a URL that 404s on every request — indistinguishable from a
  // revoked or mistyped link.
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeFilesystemCap({ withIndex: false }),
  });
  const message = await E(tool).execute({});
  t.regex(String(message), /no readable index\.html at its root/);
  t.deepEqual(asset.served, []);
});

test('an empty git worktree is refused for the same reason', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeGitCap({ withIndex: false }).git,
  });
  t.regex(String(await E(tool).execute({})), /no readable index\.html/);
  t.deepEqual(asset.served, []);
});

test('an id the server no longer lists is released before it is forgotten', async t => {
  // A release that half-failed leaves the record in the store while the
  // server has dropped the route from memory: `check` says nothing stands,
  // and after a restart it would stand again with nobody holding its id.
  const asset = makeAssetServer();
  let next = 0;
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeFilesystemCap(),
    makeId: () => `${(next += 1)}`.repeat(32),
  });
  t.regex(await E(tool).execute({}), /token-1/);
  asset.forget();
  asset.failRelease.count = 1;
  t.regex(await E(tool).execute({}), /could not be released/);
  t.is(asset.served.length, 1, 'nothing new while the old id is unaccounted for');
  t.regex(await E(tool).execute({}), /token-2/);
});

test('a serve the server refuses is reported, and the pending id is kept', async t => {
  /** @type {any} */
  let recorded;
  const refusing = Far('AssetPublisher', {
    check: async () => undefined,
    release: async () => false,
    serve: async () => {
      throw Error('the asset server can only serve a capability it can retain');
    },
  });
  const tool = makePublishTool({
    getAssetServer: async () => refusing,
    getWorkspace: async () => makeFilesystemCap(),
    loadPublication: async () => recorded,
    savePublication: async publication => {
      recorded = publication;
    },
    makeId: () => 'c'.repeat(32),
  });
  t.regex(await E(tool).execute({}), /Publishing failed: the asset server can only serve/);
  t.deepEqual(recorded, { id: 'c'.repeat(32), pending: true });
});

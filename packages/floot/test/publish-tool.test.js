// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makePublishTool } from '../src/publish-tool.js';

const makeAssetServer = () => {
  const served = [];
  const revoked = [];
  let counter = 0;
  const server = Far('AssetServer', {
    async serve(filesystem) {
      // The real server refuses a cap that cannot answer root(); mirror that,
      // so a projection regression fails here rather than 404ing in
      // production.
      // eslint-disable-next-line no-underscore-dangle
      const names = await E(filesystem).__getMethodNames__();
      if (!names.includes('root')) {
        throw Error('serve requires a Filesystem cap with a root() method');
      }
      counter += 1;
      const url = `http://host/token-${counter}/`;
      served.push({ filesystem, url });
      const revoke = Far('AssetMount', {
        async revoke() {
          revoked.push(url);
        },
      });
      return harden({ path: `/token-${counter}/`, url, revoke });
    },
  });
  return { server, served, revoked };
};

/**
 * The publisher refuses a workspace whose root has no readable index, because
 * the asset server resolves a directory request to one and a mount without it
 * 404s on every request. So every fake below carries an `index.html`; the
 * `withIndex: false` form is what the refusal is tested against.
 */
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
  // A Filesystem is already servable, so it is handed over untouched.
  t.is(asset.served[0].filesystem, workspace);
});

test('a git workspace is served through its read-only worktree', async t => {
  // The regression this pins: a session's `git-workspace` preset object is an
  // `@endo/exo-git` cap with no `root()`, so serving it directly minted a URL
  // that 404'd on every request.
  const asset = makeAssetServer();
  const { git } = makeGitCap();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => git,
  });

  const result = await E(tool).execute({});
  t.regex(result, /http:\/\/host\/token-1\//);
  t.is(asset.served.length, 1);
  t.not(asset.served[0].filesystem, git);
  // eslint-disable-next-line no-underscore-dangle
  const names = await E(asset.served[0].filesystem).__getMethodNames__();
  t.true(names.includes('root'), 'the served cap answers root()');
  t.true(names.includes('statfs'));
});

test('a Mount workspace is served through its read-only face', async t => {
  const asset = makeAssetServer();
  const mount = makeMountCap();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => mount,
  });

  await E(tool).execute({});
  t.is(asset.served.length, 1);
  t.not(asset.served[0].filesystem, mount);
  // eslint-disable-next-line no-underscore-dangle
  const names = await E(asset.served[0].filesystem).__getMethodNames__();
  t.true(names.includes('root'));
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

test('re-publishing revokes the previous mount before serving again', async t => {
  const asset = makeAssetServer();
  const workspace = makeFilesystemCap();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => workspace,
  });

  await E(tool).execute({});
  await E(tool).execute({});
  // The first URL was revoked when the second publish happened.
  t.deepEqual(asset.revoked, ['http://host/token-1/']);
  t.is(asset.served.length, 2);
});

test('revoke() releases the served mount on session teardown', async t => {
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

test('concurrent publishes serialize, so neither served mount leaks', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    getAssetServer: async () => asset.server,
    getWorkspace: async () => makeFilesystemCap(),
  });
  // Both start before either resolves. Unserialized, each would find no
  // current mount, serve its own, and only the last would be retained — the
  // first never revoked.
  const first = E(tool).execute({});
  const second = E(tool).execute({});
  await first;
  await second;
  t.is(asset.served.length, 2);
  t.deepEqual(asset.revoked, ['http://host/token-1/']);
  await tool.revoke();
  t.deepEqual(asset.revoked, ['http://host/token-1/', 'http://host/token-2/']);
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

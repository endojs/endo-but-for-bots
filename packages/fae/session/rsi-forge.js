// @ts-check
/* eslint-disable no-await-in-loop, no-continue */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { E, Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { readAuthToken } from '../src/credentials.js';

const origin = 'https://git.goooooo.ooo';
const repositories = harden({
  endo: { owner: 'floot', name: 'endo', branch: 'llm' },
  'endo-host': { owner: 'floot', name: 'nixos-config', branch: 'master' },
});
const maxPatch = 4 * 1024 * 1024;
const maxFileBytes = 2 * 1024 * 1024;
const maxFiles = 64;
const sha = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
    throw Error('Expected a full Git commit or object ID');
  return value;
};
const utf8 = bytes =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

/** @param {AsyncIterable<Uint8Array>} stream @param {number} limit */
async function* limited(stream, limit) {
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw Error('Forgejo payload exceeds its size limit');
    yield chunk;
  }
}
/** @param {AsyncIterable<Uint8Array>} stream @param {number} limit */
const read = async (stream, limit) => {
  const chunks = [];
  let frames = 0;
  for await (const chunk of limited(stream, limit)) {
    frames += 1;
    if (frames > 8192) throw Error('Too many stream frames');
    if (chunk.length) chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
const repoFor = key => {
  if (typeof key !== 'string' || !Object.hasOwn(repositories, key))
    throw Error('Choose endo or endo-host');
  return repositories[key];
};

/** @param {any} secret @param {string} username @param {typeof fetch} [request] */
export const makePullRequests = (
  secret,
  username,
  request = globalThis.fetch,
) => {
  if (
    typeof username !== 'string' ||
    username.toLowerCase() === 'floot' ||
    !/^[\w.-]{1,64}$/.test(username)
  )
    throw Error('Invalid Forgejo account');
  /** @param {any} repo @param {string} path @param {object} [payload] */
  const response = async (repo, path, payload = undefined) => {
    const password = await readAuthToken(secret);
    return request(
      repo
        ? `${origin}/api/v1/repos/${repo.owner}/${repo.name}${path ? `/${path}` : ''}`
        : `${origin}/api/v1/user`,
      {
        method: payload === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
        headers: {
          authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      },
    );
  };
  /** @param {any} repo @param {string} path @param {object} [payload] @param {boolean} [missing] */
  const json = async (repo, path, payload = undefined, missing = false) => {
    const res = await response(repo, path, payload);
    if (res.status === 204) return undefined;
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      if (missing && res.status === 404) return undefined;
      throw Error(`Forgejo returned HTTP ${res.status}`);
    }
    return JSON.parse(
      utf8(await read(/** @type {any} */ (res.body), 5 * 1024 * 1024)),
    );
  };
  const branchHead = async (repo, branch, missing = false) => {
    const info = await json(repo, `branches/${branch}`, undefined, missing);
    return info ? sha(info.commit.id) : undefined;
  };
  const verifiedFork = async repo => {
    // Unreviewed code only goes to an Actions-disabled fork. Forgejo treats
    // PRs filed by the upstream owner or writers as trusted, even from forks.
    const account = await json(null, 'user');
    const upstream = await json(repo, '');
    const fork = { ...repo, owner: username };
    const info = await json(fork, '');
    if (
      account.login !== username ||
      account.is_admin !== false ||
      account.restricted !== true ||
      upstream.full_name !== `floot/${repo.name}` ||
      upstream.permissions?.pull !== true ||
      upstream.permissions?.push !== false ||
      upstream.permissions?.admin !== false ||
      info.full_name !== `${username}/${repo.name}` ||
      info.fork !== true ||
      info.parent?.full_name !== upstream.full_name ||
      info.has_actions !== false ||
      info.private !== upstream.private
    )
      throw Error(
        'RSI requires a read-only upstream account and an Actions-disabled fork with matching visibility',
      );
    return fork;
  };
  const verify = async (key, number, head) => {
    const repo = repoFor(key);
    sha(head);
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 1
    )
      throw Error('Invalid pull request number');
    await verifiedFork(repo);
    const pr = await json(repo, `pulls/${number}`);
    const full = `floot/${repo.name}`;
    if (
      pr.number !== number ||
      pr.state !== 'open' ||
      pr.merged ||
      pr.base?.repo?.full_name !== full ||
      pr.base.ref !== repo.branch ||
      pr.head?.repo?.full_name !== `${username}/${repo.name}` ||
      pr.user?.login !== username ||
      !/^rsi-[a-f0-9]{64}$/.test(pr.head.ref) ||
      pr.head.sha !== head
    )
      throw Error('Pull request changed or is outside the RSI review scope');
    const base = sha(pr.base.sha);
    const commit = await json(repo, `git/commits/${head}`);
    if (
      commit.sha !== head ||
      commit.parents?.length !== 1 ||
      commit.parents[0].sha !== base
    )
      throw Error('Rebase this change on the current target before review');
    return harden({
      repo: key,
      number,
      head,
      base,
      url: `${origin}/${full}/pulls/${number}`,
    });
  };
  // A retried request uses exactly the same branch after a lost response.
  const publish = async (key, base, title, patch, body, topic) => {
    const repo = repoFor(key);
    const fork = await verifiedFork(repo);
    const message = `${title}\n\nRSI change ${topic}`;
    const current = await branchHead(repo, repo.branch);
    if (current !== base)
      throw Error('Target branch changed; fetch its source again');
    let head = await branchHead(fork, topic, true);
    if (!head) {
      if ((await branchHead(fork, repo.branch, true)) !== base)
        await json(fork, `sync_fork/${repo.branch}`, {});
      if ((await branchHead(fork, repo.branch)) !== base)
        throw Error('Unable to sync the review fork to the requested base');
      await json(fork, 'branches', {
        old_ref_name: base,
        new_branch_name: topic,
      });
      head = await branchHead(fork, topic);
    }
    if (head === base) {
      // Forgejo 15's ApplyDiffPatch accepts literal patch text. The branch
      // name is derived locally; a caller cannot target a deployment branch.
      await json(fork, 'diffpatch', {
        branch: topic,
        sha: base,
        content: patch,
        message,
      });
      head = await branchHead(fork, topic);
    }
    const commit = await json(fork, `git/commits/${sha(head)}`);
    if (
      commit.sha !== head ||
      commit.parents?.length !== 1 ||
      commit.parents[0].sha !== base ||
      commit.commit?.message?.trimEnd() !== message
    )
      throw Error('Unexpected candidate branch contents');
    const headRef = `${username}:${topic}`;
    const existing = await json(
      repo,
      `pulls/${repo.branch}/${encodeURIComponent(headRef)}`,
      undefined,
      true,
    );
    const pr =
      existing ||
      (await json(repo, 'pulls', {
        base: repo.branch,
        head: headRef,
        title,
        body,
      }));
    return verify(key, pr.number, head);
  };
  const pending = new Map();
  let uploads = 0;
  return Far('RSI pull requests', {
    help: () =>
      'source(repo) returns {base,commit,archive}, a tar.gz PassableBytesReader. open(repo,commit,title,patchReader,body?) submits a UTF-8 git diff --binary to a review branch. Retry the same bytes after an interruption. verify(repo,number,head) checks the exact open pull request. Repositories: endo and endo-host.',
    async source(key) {
      const repo = repoFor(key);
      const commit = await branchHead(repo, repo.branch);
      const res = await response(repo, `archive/${commit}.tar.gz`);
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw Error(`Forgejo archive returned HTTP ${res.status}`);
      }
      return harden({
        base: repo.branch,
        commit,
        archive: bytesReaderFromIterator(
          limited(/** @type {any} */ (res.body), 256 * 1024 * 1024),
        ),
      });
    },
    async open(key, base, title, reader, body = '') {
      repoFor(key);
      sha(base);
      if (
        typeof title !== 'string' ||
        !title.trim() ||
        title.length > 200 ||
        /[\r\n\0]/.test(title) ||
        typeof body !== 'string' ||
        body.length > 16_384
      )
        throw Error('Invalid pull request title or description');
      if (uploads >= 8) throw Error('Too many simultaneous patch uploads');
      uploads += 1;
      let timer;
      let iterator;
      let patch;
      try {
        iterator = iterateBytesReader(reader, {
          buffer: 0,
          stringLengthLimit: 2 * 1024 * 1024,
        });
        const stalled = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Patch upload timed out')),
            30_000,
          );
        });
        patch = utf8(await Promise.race([read(iterator, maxPatch), stalled]));
      } finally {
        uploads -= 1;
        clearTimeout(timer);
        void iterator?.return(undefined).catch(() => {});
      }
      if (!patch.startsWith('diff --git ') || patch.includes('\0'))
        throw Error('Expected a git diff --binary patch');
      const topic = `rsi-${createHash('sha256')
        .update(JSON.stringify([key, base, title, body, patch]))
        .digest('hex')}`;
      const prior = pending.get(topic);
      if (prior) return prior;
      const job = publish(key, base, title, patch, body, topic);
      pending.set(topic, job);
      try {
        return await job;
      } finally {
        pending.delete(topic);
      }
    },
    verify,
    async reviewFiles(number, head) {
      const key = 'endo-host';
      const before = await verify(key, number, head);
      const files = await changedConfigFiles(
        repoFor(key),
        before.base,
        head,
        json,
      );
      const after = await verify(key, number, head);
      if (after.base !== before.base)
        throw Error('Pull request changed during review');
      return harden(files);
    },
  });
};
harden(makePullRequests);

// The Nix workflow stages regular text files. Compare immutable Git trees
// so renames, deletions, executable modes and truncated API lists cannot be
// silently turned into a different deploy proposal.
const changedConfigFiles = async (repo, base, head, json) => {
  const treeOf = async id =>
    sha((await json(repo, `git/commits/${id}`)).commit.tree.sha);
  const entries = async id => {
    const tree = await json(repo, `git/trees/${id}`);
    if (
      tree.sha !== id ||
      tree.truncated ||
      !Array.isArray(tree.tree) ||
      tree.tree.length !== tree.total_count
    )
      throw Error('Incomplete Forgejo tree');
    return new Map(
      tree.tree.map(entry => {
        if (
          typeof entry.path !== 'string' ||
          !entry.path ||
          entry.path === '.' ||
          entry.path === '..' ||
          entry.path.toLowerCase() === '.git' ||
          /[\\/]/.test(entry.path) ||
          Array.from(entry.path).some(
            char => Number(String(char).charCodeAt(0)) < 32,
          )
        )
          throw Error('Invalid Git path');
        sha(entry.sha);
        return [entry.path, entry];
      }),
    );
  };
  const files = [];
  let bytes = 0;
  let trees = 0;
  /** @param {string} prefix @param {string | undefined} oldId @param {string} id */
  const walk = async (prefix, oldId, id) => {
    trees += 1;
    if (trees > 128 || prefix.length > 4096)
      throw Error('Config change is too large');
    const old = oldId ? await entries(oldId) : new Map();
    const next = await entries(id);
    for (const name of old.keys())
      if (!next.has(name))
        throw Error('Config deployment cannot stage deletions or renames');
    for (const [name, entry] of next) {
      const prev = old.get(name);
      if (prev?.mode === entry.mode && prev?.sha === entry.sha) continue;
      if (prev && prev.mode !== entry.mode)
        throw Error('Config deployment cannot change file modes');
      const path = prefix + name;
      if (entry.type === 'tree' && entry.mode === '040000') {
        await walk(`${path}/`, prev?.sha, entry.sha);
        continue;
      }
      if (
        entry.type !== 'blob' ||
        entry.mode !== '100644' ||
        files.length >= maxFiles
      )
        throw Error('Config deployment requires bounded regular files');
      const blob = await json(repo, `git/blobs/${entry.sha}`);
      if (
        blob.sha !== entry.sha ||
        blob.encoding !== 'base64' ||
        typeof blob.content !== 'string'
      )
        throw Error('Invalid Git blob');
      const content = Buffer.from(blob.content, 'base64');
      bytes += content.length;
      if (
        bytes > maxFileBytes ||
        content.length !== blob.size ||
        content.includes(0)
      )
        throw Error('Config change exceeds text bounds');
      files.push({ path, text: utf8(content) });
    }
  };
  await walk('', await treeOf(base), await treeOf(head));
  if (!files.length) throw Error('No config files to review');
  return files;
};

/** @param {any} powers @param {unknown} _context @param {{env?: Record<string,string>}} [options] */
export const make = (powers, _context, { env = {} } = {}) =>
  makePullRequests(
    Far('RSI credential access', {
      readBase64: () => E(E(powers).lookup('credential')).readBase64(),
    }),
    env.RSI_FORGEJO_USER || 'floot-rsi',
  );
harden(make);

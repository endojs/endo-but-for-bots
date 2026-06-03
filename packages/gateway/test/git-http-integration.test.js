// @ts-check
/* global Buffer, process */

/**
 * @file Integration test for the gateway's Git smart-HTTP handler
 *   that exercises the full round-trip with the real `git` CLI.
 *
 * The unit tests in `git-http.test.js` cover the handler's URL
 * parsing, header parsing, auth-scheme dispatch, and the
 * `resolveRepo` plumbing with stub repo capabilities. This test
 * stands up an actual `http.createServer` on an ephemeral port,
 * wires the handler to a `resolveRepo` that returns a capability
 * backed by the real `git http-backend` CGI binary, generates a
 * formula-id-shaped repo id and bearer token, and drives the real
 * `git` CLI through `push` and `pull` cycles. The end-to-end shape
 * is the canonical pattern for testing smart-HTTP servers (see
 * `git-http-backend(1)`).
 *
 * Skipped when `git` or `git-http-backend` are not present (most CI
 * runners have both; some sandboxed test environments do not).
 */

import '@endo/init/debug.js';

import test from 'ava';

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { Far } from '@endo/far';

import { makeGitHttpHandler } from '../index.js';

const HEX_ALPHABET = '0123456789abcdef';
const FORMULA_ID_LENGTH = 64;

/**
 * Locate the `git-http-backend` CGI binary. Distros place it under
 * `/usr/lib/git-core/` (Debian/Ubuntu) or under `git --exec-path`
 * (the canonical query). We try `git --exec-path` first because it
 * is the portable answer.
 *
 * @returns {string | undefined}
 */
const findGitHttpBackend = () => {
  const which = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (which.status === 0) {
    const execPath = which.stdout.trim();
    const candidate = join(execPath, 'git-http-backend');
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [
    '/usr/lib/git-core/git-http-backend',
    '/usr/libexec/git-core/git-http-backend',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const gitHttpBackend = gitAvailable ? findGitHttpBackend() : undefined;

const runIntegration = gitAvailable && gitHttpBackend !== undefined;
const integrationTest = runIntegration ? test.serial : test.serial.skip;

/**
 * Build a 64-character lowercase-hex string (the formula-id shape
 * the gateway validates). We do not need cryptographic randomness
 * for a test fixture; a deterministic-looking but unique value is
 * fine. `crypto.randomBytes` would also work; we use `Math.random`
 * to avoid pulling in the crypto powers.
 *
 * @param {number} seed
 * @returns {string}
 */
const makeHex64 = seed => {
  // Mix the seed into a 256-bit-ish hex string by chaining a tiny
  // multiplicative LCG modulo 2^32. Output is deterministic per
  // seed, which makes test failures reproducible.
  const MOD = 4_294_967_296; // 2^32
  let state = ((seed % MOD) + MOD) % MOD;
  if (state === 0) state = 1;
  let out = '';
  while (out.length < FORMULA_ID_LENGTH) {
    state = (state * 1664525 + 1013904223) % MOD;
    out += HEX_ALPHABET[state % 16];
  }
  return out;
};

/**
 * Read an `IncomingMessage` body to a single `Buffer`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
const readRequestBody = req =>
  new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', chunk => {
      chunks.push(/** @type {Buffer} */ (chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/**
 * Spawn `git http-backend` for one CGI invocation, feed it the
 * request body on stdin, and collect the CGI response from stdout.
 * The CGI response is a chunk of HTTP headers terminated by a blank
 * line followed by the body; we parse that into the
 * {@link import('../src/types.d.ts').GitHttpResponse} shape the
 * gateway handler expects.
 *
 * @param {object} args
 * @param {string} args.repoDir Absolute path to the bare git repo.
 * @param {string} args.method HTTP method.
 * @param {string} args.pathInfo The `PATH_INFO` CGI variable (the
 *   request path with the `/git/<repo-id>` prefix stripped).
 * @param {string} args.queryString The `QUERY_STRING` CGI variable.
 * @param {ReadonlyArray<readonly [string, string]>} args.headers
 *   The forwarded request headers (without the `Authorization`
 *   header; the gateway already consumed it).
 * @param {Buffer} args.body Request body bytes.
 * @returns {Promise<{ status: number, headers: ReadonlyArray<readonly [string, string]>, body: Buffer }>}
 */
const callGitHttpBackend = ({
  repoDir,
  method,
  pathInfo,
  queryString,
  headers,
  body,
}) => {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    GIT_PROJECT_ROOT: repoDir,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    REQUEST_METHOD: method,
    REMOTE_USER: 'gateway-test',
    REMOTE_ADDR: '127.0.0.1',
    PATH: process.env.PATH,
  };
  for (const [k, v] of headers) {
    const name = k.toLowerCase();
    if (name === 'content-type') env.CONTENT_TYPE = v;
    else if (name === 'content-length') env.CONTENT_LENGTH = v;
    else if (name === 'git-protocol') env.HTTP_GIT_PROTOCOL = v;
    // Other headers are dropped; the smart-HTTP protocol does not
    // depend on arbitrary request headers.
  }
  // CONTENT_LENGTH is required for POST so the backend reads the
  // exact body size and does not block on stdin.
  if (env.CONTENT_LENGTH === undefined && body.length > 0) {
    env.CONTENT_LENGTH = String(body.length);
  }
  return new Promise((resolve, reject) => {
    const cgi = spawn(/** @type {string} */ (gitHttpBackend), [], { env });
    /** @type {Buffer[]} */
    const outChunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];
    cgi.stdout.on('data', chunk => outChunks.push(chunk));
    cgi.stderr.on('data', chunk => errChunks.push(chunk));
    cgi.on('error', reject);
    cgi.on('close', code => {
      const stdout = Buffer.concat(outChunks);
      const stderr = Buffer.concat(errChunks);
      if (code !== 0 && stdout.length === 0) {
        reject(
          new Error(
            `git-http-backend exited with code ${code}: ${stderr.toString('utf8')}`,
          ),
        );
        return;
      }
      // Parse CGI response: header lines (CRLF or LF), blank line,
      // then body.
      const sep = stdout.indexOf('\r\n\r\n');
      const sepLen = sep >= 0 ? 4 : 2;
      const headerEnd = sep >= 0 ? sep : stdout.indexOf('\n\n');
      if (headerEnd < 0) {
        reject(
          new Error(
            `git-http-backend produced no header/body separator (stderr: ${stderr.toString('utf8')})`,
          ),
        );
        return;
      }
      const headerBlock = stdout.slice(0, headerEnd).toString('utf8');
      const responseBody = stdout.slice(headerEnd + sepLen);
      /** @type {Array<[string, string]>} */
      const responseHeaders = [];
      let status = 200;
      for (const line of headerBlock.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon >= 0) {
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') {
            // `Status: 200 OK` -> 200
            const match = value.match(/^(\d{3})/);
            if (match) status = Number(match[1]);
          } else {
            responseHeaders.push([name, value]);
          }
        }
      }
      resolve({ status, headers: responseHeaders, body: responseBody });
    });
    if (body.length > 0) {
      cgi.stdin.end(body);
    } else {
      cgi.stdin.end();
    }
  });
};

/**
 * Build a repo capability backed by a real bare git repo on disk.
 * The three methods each invoke `git http-backend` with the
 * appropriate `PATH_INFO`.
 *
 * @param {string} repoDir
 */
const makeFsBackedRepoCapability = repoDir => {
  return Far('FsBackedRepo', {
    /**
     * @param {{ service: string, headers: ReadonlyArray<readonly [string, string]> }} args
     */
    infoRefs: async args => {
      const { status, headers, body } = await callGitHttpBackend({
        repoDir,
        method: 'GET',
        pathInfo: '/info/refs',
        queryString: `service=${args.service}`,
        headers: args.headers,
        body: Buffer.alloc(0),
      });
      return harden({
        status,
        headers: harden(
          headers.map(([k, v]) => /** @type {[string, string]} */ ([k, v])),
        ),
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      });
    },
    /**
     * @param {{ requestBody: Uint8Array, headers: ReadonlyArray<readonly [string, string]> }} args
     */
    gitUploadPack: async args => {
      const buf = Buffer.from(
        args.requestBody.buffer,
        args.requestBody.byteOffset,
        args.requestBody.byteLength,
      );
      const { status, headers, body } = await callGitHttpBackend({
        repoDir,
        method: 'POST',
        pathInfo: '/git-upload-pack',
        queryString: '',
        headers: args.headers,
        body: buf,
      });
      return harden({
        status,
        headers: harden(
          headers.map(([k, v]) => /** @type {[string, string]} */ ([k, v])),
        ),
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      });
    },
    /**
     * @param {{ requestBody: Uint8Array, headers: ReadonlyArray<readonly [string, string]> }} args
     */
    gitReceivePack: async args => {
      const buf = Buffer.from(
        args.requestBody.buffer,
        args.requestBody.byteOffset,
        args.requestBody.byteLength,
      );
      const { status, headers, body } = await callGitHttpBackend({
        repoDir,
        method: 'POST',
        pathInfo: '/git-receive-pack',
        queryString: '',
        headers: args.headers,
        body: buf,
      });
      return harden({
        status,
        headers: harden(
          headers.map(([k, v]) => /** @type {[string, string]} */ ([k, v])),
        ),
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      });
    },
  });
};

/**
 * Bridge a Node `IncomingMessage` / `ServerResponse` pair to the
 * gateway handler's request/response shape.
 *
 * @param {import('../src/types.d.ts').GitHttpHandler} handler
 */
const makeHttpListener = handler => {
  return async (
    /** @type {import('node:http').IncomingMessage} */ req,
    /** @type {import('node:http').ServerResponse} */ res,
  ) => {
    try {
      // eslint-disable-next-line @jessie.js/safe-await-separator
      const bodyBuf = await readRequestBody(req);
      const url = new URL(req.url || '/', 'http://127.0.0.1/');
      const headers = /** @type {Array<[string, string]>} */ ([]);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      }
      const request = harden({
        method: req.method || 'GET',
        path: url.pathname,
        query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
        headers: harden(
          headers.map(([k, v]) => /** @type {[string, string]} */ ([k, v])),
        ),
        body: new Uint8Array(bodyBuf),
      });
      const response = await handler.handleRequest(request);
      res.statusCode = response.status;
      for (const [name, value] of response.headers) {
        res.setHeader(name, value);
      }
      res.end(
        Buffer.from(
          response.body.buffer,
          response.body.byteOffset,
          response.body.byteLength,
        ),
      );
    } catch (e) {
      res.statusCode = 500;
      res.end(String(/** @type {Error} */ (e).message));
    }
  };
};

/**
 * Run a child process to completion, returning stdout/stderr.
 *
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', reject);
    child.on('close', status =>
      resolve({
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });

integrationTest(
  'git CLI push and pull through the Gateway with bearer auth',
  async t => {
    t.timeout(60_000);

    // Allocate the four worktrees the test uses: the server-side
    // bare repo the gateway exposes, a "push" working tree that
    // creates a commit and pushes it, and a "pull" working tree that
    // clones from the gateway to verify the pushed ref survived the
    // round trip. A fourth scratch dir holds the credentials helper
    // script.
    const rootDir = await mkdtemp(join(tmpdir(), 'gw-git-int-'));
    t.teardown(() => rm(rootDir, { recursive: true, force: true }));
    const bareRepoDir = join(rootDir, 'origin.git');
    const pushTreeDir = join(rootDir, 'push-tree');
    const pullTreeDir = join(rootDir, 'pull-tree');

    // Initialize the bare repo with an initial branch named `main`.
    const init = await run('git', [
      'init',
      '--bare',
      '--initial-branch=main',
      bareRepoDir,
    ]);
    t.is(init.status, 0, `git init --bare failed: ${init.stderr}`);
    // The smart-HTTP receive-pack refuses to take a push from a
    // non-bare-default config without this. The default for newer
    // git is to allow, but pin it for older bundled versions.
    await run('git', ['config', 'http.receivepack', 'true'], {
      cwd: bareRepoDir,
    });
    await run('git', ['config', 'receive.denyCurrentBranch', 'updateInstead'], {
      cwd: bareRepoDir,
    });

    // Mint a formula-id-shaped repo id and bearer token. The
    // `Math.random` source is fine for tests; the handler validates
    // the shape (64 lowercase hex) but does not check entropy.
    const repoId = makeHex64(0xb0b5c4fe);
    const token = makeHex64(0xdeadbeef);
    const wrongToken = makeHex64(0xfeedface);

    // Wire the handler with a resolveRepo that authorizes only the
    // (repoId, token) pair we minted; everything else returns
    // undefined (the handler maps that to 401).
    /** @type {Array<{ token: string, repoId: string, granted: boolean }>} */
    const resolveCalls = [];
    const handler = makeGitHttpHandler({
      resolveRepo: async args => {
        const granted = args.token === token && args.repoId === repoId;
        resolveCalls.push({ token: args.token, repoId: args.repoId, granted });
        if (!granted) return undefined;
        return makeFsBackedRepoCapability(bareRepoDir);
      },
    });

    // Stand up the HTTP server on an ephemeral port.
    const server = createServer(makeHttpListener(handler));
    await new Promise(resolve =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    t.teardown(
      () => new Promise(resolve => server.close(() => resolve(undefined))),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      t.fail('server address is not an inet address');
      return;
    }
    const port = address.port;
    const remoteUrl = `http://127.0.0.1:${port}/git/${repoId}/`;

    // Build the env the `git` CLI uses on every invocation: include
    // the bearer token via `http.extraHeader`, suppress any global
    // credentials, and disable the prompt so a hung credential helper
    // cannot stall the test. The Authorization header is the
    // canonical way to inject a bearer; `git -c http.extraHeader` is
    // the official knob.
    /** @type {NodeJS.ProcessEnv} */
    const gitEnv = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true', // returns empty -> no prompt
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Gateway Test',
      GIT_AUTHOR_EMAIL: 'gateway-test@example.invalid',
      GIT_COMMITTER_NAME: 'Gateway Test',
      GIT_COMMITTER_EMAIL: 'gateway-test@example.invalid',
    };

    /**
     * @param {ReadonlyArray<string>} args
     * @param {string} cwd
     * @param {{ token?: string }} [opts]
     */
    const gitCmd = (args, cwd, opts = {}) => {
      const usedToken = opts.token ?? token;
      const headerOpts = [
        '-c',
        `http.extraHeader=Authorization: bearer ${usedToken}`,
      ];
      return run('git', [...headerOpts, ...args], { cwd, env: gitEnv });
    };

    // ---------- Push round-trip ----------
    // Create a working tree, commit a file, and push to the gateway.
    {
      const init2 = await run('git', [
        'init',
        '--initial-branch=main',
        pushTreeDir,
      ]);
      t.is(init2.status, 0, `git init push tree: ${init2.stderr}`);
      // Drop a file and commit.
      await run('node', [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(join(pushTreeDir, 'hello.txt'))}, 'hello from the gateway\\n')`,
      ]);
      const add = await run('git', ['add', 'hello.txt'], {
        cwd: pushTreeDir,
        env: gitEnv,
      });
      t.is(add.status, 0, `git add: ${add.stderr}`);
      const commit = await run(
        'git',
        ['commit', '-m', 'initial commit from push tree'],
        { cwd: pushTreeDir, env: gitEnv },
      );
      t.is(commit.status, 0, `git commit: ${commit.stderr}`);

      // First, prove that pushing without the bearer fails. We use a
      // bearer that the resolveRepo does not authorize; this exercises
      // the 401 path on the wire.
      const noAuth = await gitCmd(
        ['push', remoteUrl, 'main:main'],
        pushTreeDir,
        { token: wrongToken },
      );
      t.not(
        noAuth.status,
        0,
        `push with wrong token unexpectedly succeeded: ${noAuth.stdout}`,
      );
      t.regex(
        noAuth.stderr,
        /401|unauthorized|Authentication failed/i,
        `push with wrong token did not surface 401: stderr=${noAuth.stderr}`,
      );

      // Now push with the right bearer.
      const push = await gitCmd(['push', remoteUrl, 'main:main'], pushTreeDir);
      t.is(
        push.status,
        0,
        `git push failed: stderr=${push.stderr} stdout=${push.stdout}`,
      );
    }

    // ---------- Pull round-trip ----------
    // Clone from the gateway into a fresh working tree, then verify
    // the file we pushed survived.
    {
      const clone = await gitCmd(['clone', remoteUrl, pullTreeDir], rootDir);
      t.is(
        clone.status,
        0,
        `git clone failed: stderr=${clone.stderr} stdout=${clone.stdout}`,
      );
      // Confirm the file is there.
      const ls = await run('git', ['ls-files'], {
        cwd: pullTreeDir,
        env: gitEnv,
      });
      t.is(ls.status, 0, `git ls-files: ${ls.stderr}`);
      t.regex(
        ls.stdout,
        /^hello\.txt$/m,
        `clone tree missing hello.txt: ${ls.stdout}`,
      );
      // And the log shows our commit.
      const log = await run('git', ['log', '--oneline', '-n', '1'], {
        cwd: pullTreeDir,
        env: gitEnv,
      });
      t.is(log.status, 0, `git log: ${log.stderr}`);
      t.regex(log.stdout, /initial commit from push tree/);
    }

    // The handler observed at least one rejected attempt (the wrong
    // bearer) and at least one granted attempt (push, then clone).
    // Each smart-HTTP operation makes multiple requests (info/refs
    // then git-receive-pack or git-upload-pack), so resolveCalls is
    // larger than 3; we just check the two outcomes are both present.
    t.true(
      resolveCalls.some(c => !c.granted),
      `expected at least one denied resolveRepo call: ${JSON.stringify(resolveCalls)}`,
    );
    t.true(
      resolveCalls.some(c => c.granted),
      `expected at least one granted resolveRepo call: ${JSON.stringify(resolveCalls)}`,
    );
  },
);

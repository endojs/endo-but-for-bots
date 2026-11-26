#!/usr/bin/env node
// @ts-check
/**
 * Pre-flight check of a state directory before a (re)start, changing
 * nothing (Tokyo plan 4.2, 5.2 `runtimePinGuard`):
 *
 * - the state exists; a warning when it, or the Secrets wrapping key, is
 *   under /tmp or /private/tmp (a reboot or temp cleaner deletes them);
 * - `harness-serve.json`: whether the last stop was clean;
 * - `workspace.json` and `heaps/runtime.json` are present and readable;
 * - the worker binary (`THIXOTROPE_IRONHORSE_WORKER`, else the repository's
 *   `target/release` build) and the boot bundles (`@endo/thixotrope`
 *   `dist-ironhorse/`) have the sha256 digests `runtime.json` pins;
 * - every bundle digest `installations.json` records is in `bundles/` with
 *   those bytes;
 * - the wrapping key (`THIX_HARNESS_SECRETS_KEY`, else the default path) is
 *   present, 32 bytes, private, outside the state, and opens every sealed
 *   file there (`secrets.enc`, the audit log, `gateway/signin.enc`). Only
 *   "ok" or "fail" is printed for each: never a value, a key or file bytes.
 *   A missing key is a failure when sealed files exist (the service would
 *   refuse to start) or when it is a systemd credential, else a warning (a
 *   first start creates it).
 *
 * Usage: node scripts/preflight.mjs STATE
 * Run it with the same environment as the service (the key variable, the
 * worker path, `CREDENTIALS_DIRECTORY`). Each line is `ok`, `warn` or
 * `fail`, a check name and a detail; the exit code is 1 when any check
 * failed, else 0.
 */
import './_init.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

import { SERVE_RECORD, isUnderTmp, readServeRecord } from './serve.mjs';

/**
 * @typedef {object} PreflightResult
 * @property {'ok' | 'warn' | 'fail'} status
 * @property {string} check
 * @property {string} detail
 */

/** The boot bundles the supervisor runs, in `runtime.json`'s order. */
const BOOT_BUNDLES = harden(['boot.js', 'worker-peer.js']);

/** @param {string} file */
const sha256File = file =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });

/** @param {unknown} error */
const codeOf = error => /** @type {any} */ (error)?.code ?? 'error';

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
const exists = async file => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
};

/** The `@endo/thixotrope` package directory. */
const defaultThixotropeRoot = () =>
  path.dirname(
    url.fileURLToPath(import.meta.resolve('@endo/thixotrope/package.json')),
  );

/**
 * @param {object} options
 * @param {string} options.statePath
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.thixotropeRoot] the `@endo/thixotrope` package
 * @returns {Promise<PreflightResult[]>}
 */
export const preflight = async ({
  statePath: given,
  env = process.env,
  thixotropeRoot = defaultThixotropeRoot(),
}) => {
  const statePath = path.resolve(given);
  /** @type {PreflightResult[]} */
  const results = [];
  /**
   * @param {PreflightResult['status']} status
   * @param {string} check
   * @param {string} detail
   */
  const report = (status, check, detail) =>
    results.push(harden({ status, check, detail }));
  /**
   * @template T
   * @param {string} check
   * @param {() => Promise<T>} fn
   * @returns {Promise<T | undefined>}
   */
  const guarded = async (check, fn) => {
    try {
      return await fn();
    } catch (error) {
      report('fail', check, /** @type {Error} */ (error).message);
      return undefined;
    }
  };

  // The state directory.
  const info = await stat(statePath).catch(error => error);
  if (info instanceof Error || !info.isDirectory()) {
    report(
      'fail',
      'state',
      `${statePath} is not a directory (${info instanceof Error ? codeOf(info) : 'not a directory'})`,
    );
    return harden(results);
  }
  report('ok', 'state', statePath);
  if (await isUnderTmp(statePath))
    report(
      'warn',
      'state location',
      'under a temporary directory: a reboot or temp cleaner deletes it',
    );

  await guarded(SERVE_RECORD, async () => {
    const record = await readServeRecord(statePath);
    if (record === undefined) report('warn', SERVE_RECORD, 'absent');
    else if (record.status === 'clean')
      report('ok', SERVE_RECORD, `the last stop was clean`);
    else
      report(
        'warn',
        SERVE_RECORD,
        `status running (pid ${record.pid ?? '?'}): a supervisor is serving, or the last stop was not clean`,
      );
  });

  /**
   * @param {string} name
   * @returns {Promise<any>}
   */
  const readJson = async name => {
    const text = await readFile(path.join(statePath, name), 'utf8').catch(
      error => {
        throw Error(`cannot be read (${codeOf(error)})`);
      },
    );
    try {
      return JSON.parse(text);
    } catch {
      throw Error('is not valid JSON');
    }
  };

  const workspace = await guarded('workspace.json', () =>
    readJson('workspace.json'),
  );
  if (workspace !== undefined) report('ok', 'workspace.json', 'present');

  // The runtime pins: the worker binary and the boot bundles.
  const runtime = await guarded('heaps/runtime.json', () =>
    readJson(path.join('heaps', 'runtime.json')),
  );
  if (runtime !== undefined) {
    report('ok', 'heaps/runtime.json', `format ${runtime.format}`);
    const workerBinary =
      env.THIXOTROPE_IRONHORSE_WORKER ??
      path.resolve(
        thixotropeRoot,
        '../../target/release/thixotrope-ironhorse-worker',
      );
    await guarded('worker digest', async () => {
      const digest = await sha256File(workerBinary).catch(error => {
        throw Error(`${workerBinary} cannot be read (${codeOf(error)})`);
      });
      if (digest === runtime.worker)
        report('ok', 'worker digest', `${workerBinary} matches`);
      else
        report(
          'fail',
          'worker digest',
          `${workerBinary} is ${digest}, runtime.json pins ${runtime.worker}`,
        );
    });
    const pinned = Array.isArray(runtime.bootstrap) ? runtime.bootstrap : [];
    if (pinned.length !== BOOT_BUNDLES.length)
      report(
        'fail',
        'boot bundles',
        `runtime.json pins ${pinned.length} boot bundles, this release has ${BOOT_BUNDLES.length}`,
      );
    else
      await guarded('boot bundles', async () => {
        const files = BOOT_BUNDLES.map(name =>
          path.join(thixotropeRoot, 'dist-ironhorse', name),
        );
        const digests = await Promise.all(
          files.map(file =>
            sha256File(file).catch(error => {
              throw Error(`${file} cannot be read (${codeOf(error)})`);
            }),
          ),
        );
        const differ = files.filter((_file, at) => digests[at] !== pinned[at]);
        if (differ.length === 0)
          report('ok', 'boot bundles', `${files.length} match`);
        else
          report(
            'fail',
            'boot bundles',
            `differ from runtime.json: ${differ.join(', ')}`,
          );
      });
  }

  // The bundles the installation index records.
  const index = await guarded('installations.json', () =>
    readJson('installations.json'),
  );
  if (index !== undefined) {
    const entries = Array.isArray(index.entries) ? index.entries : [];
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const missingNotReady = [];
    const recorded = entries.flatMap(entry =>
      ['bundleDigest', 'durableDigest', 'ephemeralDigest']
        .filter(field => entry?.[field] !== undefined)
        .map(field => ({ entry, field, digest: String(entry[field]) })),
    );
    const checked = recorded.length;
    const actuals = await Promise.all(
      recorded.map(({ digest }) =>
        /^[0-9a-f]{64}$/.test(digest)
          ? sha256File(path.join(statePath, 'bundles', `${digest}.cjs`)).catch(
              () => undefined,
            )
          : undefined,
      ),
    );
    recorded.forEach(({ entry, field, digest }, at) => {
      if (actuals[at] === digest) return;
      const label = `${entry.workspace ?? 'daemon'}/${entry.name} ${field}`;
      (entry.status === 'ready' ? missing : missingNotReady).push(label);
    });
    if (missing.length > 0)
      report(
        'fail',
        'bundles',
        `missing or changed for ${missing.length} of ${checked}: ${missing.join(', ')}`,
      );
    else report('ok', 'bundles', `${checked} recorded digests present`);
    if (missingNotReady.length > 0)
      report(
        'warn',
        'bundles',
        `missing for installations not ready: ${missingNotReady.join(', ')}`,
      );
  }

  // The Secrets wrapping key and the files sealed with it.
  const { installGuestPrelude } = await import('./guest-prelude.js');
  installGuestPrelude();
  const [store, wrapping, signin] = await Promise.all([
    import('../resources/agent-host/impl/secrets/store.js'),
    import('../resources/agent-host/impl/secrets/wrapping-key.js'),
    import('../resources/agent-host/impl/gateway/signin.js'),
  ]);
  const files = await guarded('key', async () =>
    store.findSecretsFiles({ stateDir: statePath, env }),
  );
  if (files === undefined) return harden(results);
  const { keyFile, keyReadOnly } = files;
  if (!env[store.SECRETS_KEY_VARIABLE])
    report(
      'warn',
      'key location',
      `${store.SECRETS_KEY_VARIABLE} is unset: the default ${keyFile}`,
    );
  if (await isUnderTmp(keyFile))
    report(
      'warn',
      'key location',
      `${keyFile} is under a temporary directory: a reboot or temp cleaner deletes it`,
    );
  const sealed = [];
  for (const file of wrapping.sealedStateFiles(statePath)) {
    if (await exists(file)) sealed.push(file);
  }
  const keyPresent = await exists(keyFile).catch(() => true);
  if (!keyPresent) {
    if (sealed.length > 0)
      report(
        'fail',
        'key',
        `${keyFile} is missing and the state holds sealed files: the service refuses to start; restore the key from its backup`,
      );
    else if (keyReadOnly)
      report(
        'fail',
        'key',
        `${keyFile} is missing from the credentials directory`,
      );
    else
      report(
        'warn',
        'key',
        `${keyFile} is absent; the state holds no sealed files, so the first start creates it`,
      );
    return harden(results);
  }
  // Read-only: a load that never creates or writes anything.
  const key = await guarded('key', () =>
    wrapping.loadWrappingKey({
      keyFile,
      stateDir: statePath,
      readOnly: true,
    }),
  );
  if (key === undefined) return harden(results);
  report(
    'ok',
    'key',
    `${keyFile}: 32 bytes, private${keyReadOnly ? ', a read-only credential' : ''}`,
  );
  if (sealed.length === 0)
    report('ok', 'key matches', 'no sealed files yet (a fresh state)');
  for (const file of sealed) {
    const name = path.relative(statePath, file);
    const raw = await readFile(file).catch(() => undefined);
    let opens = false;
    if (raw === undefined) opens = false;
    else if (name.endsWith('secrets.enc'))
      opens = store.secretsFileOpens(key, raw);
    else if (name.endsWith('signin.enc'))
      opens = signin.signInFileOpens(key, raw);
    else {
      // The audit log: its first whole line (a torn last line is normal).
      const line = raw
        .toString('utf8')
        .split('\n')
        .find(text => text !== '');
      opens = line === undefined || store.auditLineOpens(key, line);
    }
    report(opens ? 'ok' : 'fail', `key opens ${name}`, opens ? 'ok' : 'fail');
  }
  key.fill(0);
  return harden(results);
};
harden(preflight);

/** @param {string[]} argv */
const main = async argv => {
  if (argv.length !== 1 || argv[0].startsWith('-'))
    throw Error('usage: preflight.mjs STATE');
  const results = await preflight({ statePath: argv[0] });
  for (const { status, check, detail } of results)
    process.stdout.write(`${status.padEnd(4)} ${check}: ${detail}\n`);
  process.exitCode = results.some(({ status }) => status === 'fail') ? 1 : 0;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`preflight: ${error.message}\n`);
    process.exitCode = 1;
  });
}

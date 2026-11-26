#!/usr/bin/env node
// @ts-check
/**
 * The explicit Secrets wrapping key initialisation (Tokyo plan 4.2
 * `init-key`): create a new 32-byte key file, mode 0600, whole or not at
 * all (`initWrappingKey`). It refuses when the file exists (a key is never
 * replaced), when it is a systemd credential (create it at the
 * credential's source instead), and when STATE already holds files sealed
 * with a key (a new key cannot open them).
 *
 * Usage: node scripts/init-secrets-key.mjs KEYFILE [--state STATE]
 * Prints the path it created, never the key. Copy the key off the machine
 * next (README, "Where state and the key live, and backups").
 */
import './_init.mjs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

/** @param {string[]} argv */
const main = async argv => {
  /** @type {string | undefined} */
  let keyFile;
  /** @type {string | undefined} */
  let stateDir;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state' && argv[i + 1] !== undefined) {
      stateDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (!arg.startsWith('-') && keyFile === undefined) keyFile = arg;
    else throw Error('usage: init-secrets-key.mjs KEYFILE [--state STATE]');
  }
  if (keyFile === undefined || !path.isAbsolute(keyFile))
    throw Error(
      'usage: init-secrets-key.mjs KEYFILE [--state STATE] (KEYFILE absolute)',
    );
  const { initWrappingKey, isCredentialPath } =
    await import('../resources/agent-host/impl/secrets/wrapping-key.js');
  await initWrappingKey({
    keyFile,
    stateDir,
    readOnly: isCredentialPath(keyFile, process.env),
  });
  process.stdout.write(`created ${keyFile}\n`);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`init-secrets-key: ${error.message}\n`);
    process.exitCode = 1;
  });
}

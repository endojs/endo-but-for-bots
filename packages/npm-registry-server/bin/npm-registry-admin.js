#!/usr/bin/env node
// @ts-check
/* global process */

import '@endo/init';

import Database from 'better-sqlite3';
import { openRegistry } from '../src/server.js';
import { makeToken } from '../src/grants.js';

const usage = `usage: npm-registry-admin <command>
  grants list
  grants issue <id> <subject> <package[,package...]> <expires-iso>
      prints a fresh bearer token once; only its hash is stored
  grants revoke <id>
  verify
      exit 1 if any stored version is missing its tarball or tree
Reads REGISTRY_STATE_DIR (and PUBLIC_REGISTRY_URL, default https://npm.minion.town).`;

const [command, subcommand, ...args] = process.argv.slice(2);
const stateDir = process.env.REGISTRY_STATE_DIR;
if (!stateDir || !command) {
  console.error(usage);
  process.exit(2);
}
const { grants, registry, db } = openRegistry({
  stateDir,
  publicOrigin: process.env.PUBLIC_REGISTRY_URL || 'https://npm.minion.town',
  openDatabase: file => new Database(file),
});

let status = 0;
if (command === 'grants' && subcommand === 'list') {
  console.log(JSON.stringify(grants.listGrants(), null, 2));
} else if (
  command === 'grants' &&
  subcommand === 'issue' &&
  args.length === 4
) {
  const [id, subject, packages, expires] = args;
  const expiresAt = Date.parse(expires);
  if (Number.isNaN(expiresAt)) {
    console.error(`invalid expiry ${expires}`);
    process.exit(2);
  }
  const token = makeToken();
  grants.putGrant({
    id,
    subject,
    packages: packages.split(','),
    expiresAt,
    token,
  });
  console.log(token);
} else if (
  command === 'grants' &&
  subcommand === 'revoke' &&
  args.length === 1
) {
  status = grants.revokeGrant(args[0]) ? 0 : 1;
} else if (command === 'verify') {
  const missing = registry.verifyStore();
  for (const coordinate of missing) {
    console.error(`missing content: ${coordinate}`);
  }
  status = missing.length > 0 ? 1 : 0;
} else {
  console.error(usage);
  status = 2;
}
/** @type {any} */ (db).close?.();
process.exit(status);

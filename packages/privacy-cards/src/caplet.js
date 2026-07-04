// @ts-check
/* global setTimeout */

// Privacy.com account caplet — an Endo daemon *unconfined* formula.
//
// Provision with the API key in the formula's env, e.g.:
//
//   endo make --UNCONFINED packages/privacy-cards/src/caplet.js \
//     --name privacy-account --powers @none
//
// with env: PRIVACY_API_KEY (required), PRIVACY_API_BASE_URL (optional;
// defaults to production, point at https://sandbox.privacy.com/v1 for
// the sandbox), PRIVACY_STATE_FILE (optional; JSON ledger persistence
// across daemon restarts — without it the ledger is in-memory only).
//
// This file is only the Node shell: it turns ambient Node authority
// (fetch, the filesystem, the clock, timers) into the injected powers
// that `account.js` — the portable, confinable core — consumes. The
// returned PrivacyAccount facet is for the account owner alone; see
// src/account.js and designs/privacy-card-issuer.md for the facet
// model and budget semantics.

import { makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';

import fs from 'node:fs';
import path from 'node:path';

import { makeAccount } from './account.js';
import { PRODUCTION_BASE_URL, makePrivacyClient } from './client.js';
import { makeBudgetLedger } from './ledger.js';

/**
 * Atomic-ish JSON persistence: write to a temp file, then rename.
 *
 * @param {string} stateFile
 */
const makeFileHooks = stateFile => {
  return harden({
    restore: () => {
      try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch (cause) {
        if (/** @type {NodeJS.ErrnoException} */ (cause).code === 'ENOENT') {
          return undefined;
        }
        throw cause;
      }
    },
    /** @param {object} state */
    persist: state => {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state));
      fs.renameSync(temporary, stateFile);
    },
  });
};

/** @param {number} ms */
const delay = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Unconfined caplet entry point.
 *
 * @param {unknown} _powers
 * @param {unknown} context daemon caplet context (whenCancelled teardown)
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 */
export const make = (_powers, context, { env = {} } = {}) => {
  const apiKey = env.PRIVACY_API_KEY;
  if (!apiKey) {
    throw makeError(X`PRIVACY_API_KEY is required in the caplet env`);
  }
  const baseUrl = env.PRIVACY_API_BASE_URL || PRODUCTION_BASE_URL;
  const stateFile = env.PRIVACY_STATE_FILE;

  const client = makePrivacyClient({ apiKey, baseUrl });
  const ledger = makeBudgetLedger({
    ...(stateFile ? makeFileHooks(stateFile) : {}),
    now: () => Date.now(),
  });
  const { account, dispose } = makeAccount({ client, ledger, delay });

  // Stop spend-monitor polling loops when the formula is cancelled or
  // re-provisioned, so the worker does not keep polling a dead grant.
  if (context) {
    E(/** @type {any} */ (context))
      .whenCancelled()
      .catch(() => dispose());
  }

  return account;
};
harden(make);

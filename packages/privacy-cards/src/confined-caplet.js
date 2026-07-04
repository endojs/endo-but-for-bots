// @ts-check

// Privacy.com account caplet — *confined* variant.
//
// Unlike caplet.js (the unconfined Node shell), this module imports no
// Node builtins and expects **no API key at all**: `powers` must be a
// mediated HTTP capability in the endoclaw-network-fetch /
// endoclaw-oauth shape, already bound to the Privacy API base URL,
// that injects the `Authorization` header on the host's side of the
// membrane:
//
//   interface PrivacyHttp {
//     fetch(path: string, options?: { method?, headers?, body? }):
//       Promise<PrivacyHttpResponse>;
//   }
//   interface PrivacyHttpResponse {  // remotable: methods, not fields
//     status(): Promise<number>;
//     json(): Promise<unknown>;
//     text(): Promise<string>;
//   }
//
// With that shape granted as the caplet's powers, the entire budget
// machinery runs inside a compartment that could not name the key
// even if fully compromised — the credential lives on the other side
// of the fetch capability. Until a standard mediated-fetch caplet
// ships, this entry point is exercised by unit test (a local exo over
// the mock API) rather than by `endo make <archive>`.
//
// Trade-offs versus the unconfined shell, pending more capabilities:
// - No filesystem, so the ledger is in-memory; provision with a
//   storage capability (or re-run repair() after restarts) until a
//   persistence capability is standardized.
// - No timer authority, so spend monitors are unavailable unless a
//   delay capability is added to the powers.

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { makeAccount } from './account.js';
import { makePrivacyProtocol } from './client.js';
import { makeBudgetLedger } from './ledger.js';

/** @import { PrivacyJsonCaller } from './client.js' */

/**
 * @param {any} powers a PrivacyHttp capability (see module comment)
 * @param {unknown} _context
 */
export const make = (powers, _context) => {
  if (!powers) {
    throw makeError(
      X`The confined Privacy caplet requires a mediated HTTP capability as its powers`,
    );
  }

  /** @type {PrivacyJsonCaller} */
  const call = async (method, path, body) => {
    const response = await E(powers).fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    const status = /** @type {number} */ (await E(response).status());
    if (status < 200 || status >= 300) {
      throw makeError(
        X`Privacy API ${q(method)} ${q(path)} failed with status ${q(status)}`,
      );
    }
    return E(response).json();
  };

  const client = makePrivacyProtocol(call);
  // In-memory ledger and no timer authority, per the module comment;
  // both are seams awaiting standard storage and timer capabilities.
  const { account } = makeAccount({ client, ledger: makeBudgetLedger() });
  return account;
};
harden(make);

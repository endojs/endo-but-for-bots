import os from 'os';

import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';
import { makeHttpClientPolicy } from '../http-mk-policy.js';

/**
 * `endo http mk <name> --origin <origin> ...` — mint a confined outbound-HTTP
 * client capability under a host-curated policy and register it under `<name>`
 * (Phase 1 of `designs/cli-http-client.md`). The daemon's
 * `normalizeHttpClientPolicy` is the authority on policy validity; this verb
 * assembles the record and lets a bad field surface as its structured error.
 *
 * Re-running `mk` on a name that already denotes a client rebinds the name to a
 * freshly minted client under the new policy; the previously bound client is
 * *not* revoked (revocation lands with a later phase's verbs), so prefer a
 * fresh name until those verbs exist.
 *
 * @param {object} args
 * @param {string} args.name - Pet name for the minted HTTP client.
 * @param {string[]} args.allowedOrigins - Allowed origins (http:/https:).
 * @param {number} [args.maxRequestsPerMinute] - Sliding-window rate cap.
 * @param {number} [args.maxResponseBytes] - Per-response byte cap.
 * @param {'strict' | 'tofu-auto'} [args.policyMode] - `strict` (default) or
 *   `tofu-auto` (auto-allows any first-seen origin — see the flag help).
 * @param {string} [args.agentNames] - Agent to act as.
 */
export const httpMk = async ({
  name,
  allowedOrigins,
  maxRequestsPerMinute,
  maxResponseBytes,
  policyMode,
  agentNames,
}) => {
  const parsedName = parsePetNamePath(name);
  const policy = makeHttpClientPolicy({
    allowedOrigins,
    maxRequestsPerMinute,
    maxResponseBytes,
    policyMode,
  });

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).provideHttpClient(parsedName, policy);
    console.log(name);
  });
};

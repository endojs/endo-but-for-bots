import os from 'os';

import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * `endo http mk <name> --origin <url> ...`
 *
 * Mint a confined outbound-HTTP client capability under a host-curated
 * policy and register it under `<name>`.  Phase 1 of
 * `designs/cli-http-client.md`, riding the HTTP client that already landed on
 * the daemon: the host method is `provideHttpClient(name, policy)` (backed by
 * `@endo/exo-http-client` over `@endo/http-confine`), so the verb takes a
 * *policy* — an origin allowlist plus optional rate / size / mode guards —
 * rather than the controller/client formula pair the original design assumed.
 * The host retains the paired control facet (reachable via
 * `getHttpClientControl`); mutating and revoking it are a later phase's verbs.
 *
 * The daemon's `normalizeHttpClientPolicy` is the authority on policy validity
 * (origin shape, positive-integer guards, admissible `policyMode`); this verb
 * only assembles the record and lets a bad field surface as the daemon's
 * structured error on the CLI invocation.
 *
 * @param {object} args
 * @param {string} args.name - Pet name for the minted HTTP client.
 * @param {string[]} args.allowedOrigins - Allowed origin URLs (http:/https:).
 * @param {number} [args.maxRequestsPerMinute] - Sliding-window rate cap.
 * @param {number} [args.maxResponseBytes] - Per-response byte cap.
 * @param {string} [args.policyMode] - `strict` (default) or `tofu-auto`.
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
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error('endo http mk requires at least one --origin <url> entry');
  }

  const parsedName = parsePetNamePath(name);
  const policy = {
    allowedOrigins,
    // Include the guard knobs only when supplied so the daemon applies its
    // own defaults otherwise (its normalizer rejects an undefined numeric).
    ...(maxRequestsPerMinute !== undefined ? { maxRequestsPerMinute } : {}),
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    ...(policyMode !== undefined ? { policyMode } : {}),
  };

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).provideHttpClient(parsedName, policy);
    console.log(name);
  });
};

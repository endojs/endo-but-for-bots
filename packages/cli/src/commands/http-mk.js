import os from 'os';

import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';
import { makeHttpClientPolicy } from '../http-mk-policy.js';

/**
 * `endo http mk <name> --origin <origin> ...` — mint a confined outbound-HTTP
 * client capability under a host-curated policy and register it under `<name>`
 * (Phase 1 of `designs/cli-http-client.md`). The daemon's
 * `normalizeHttpClientPolicy` is the authority on policy *semantics*; this verb
 * validates each flag's lexical shape locally and reports by flag name, then
 * assembles the record and lets a bad field surface as its structured error.
 *
 * (Rebind semantics — a re-`mk` drops the old name's reference, and the daemon
 * collects the orphaned client unless another edge still retains it — are stated
 * for the release-note and design readers in the changeset and
 * `designs/cli-http-client.md`.)
 *
 * @param {object} args
 * @param {string} args.name - Pet name for the minted HTTP client.
 * @param {string[] | undefined} args.allowedOrigins - Allowed origins
 *   (http:/https:); `undefined` when `--origin` was omitted (rejected below).
 * @param {number} [args.maxRequestsPerMinute] - Sliding-window rate cap.
 * @param {number} [args.maxResponseBytes] - Per-response byte cap.
 * @param {'strict' | 'tofu-auto'} [args.policyMode] - `strict` (default) or
 *   `tofu-auto` (auto-allows any first-seen origin — see the flag help).
 * @param {boolean} [args.acknowledgeUnbounded] - Set by `--acknowledge-unbounded`;
 *   required with `tofu-auto`, which mints an unbounded capability Phase 1 ships
 *   no verb to inspect or revoke.
 * @param {string} [args.agentNames] - Agent to act as. `provideHttpClient` is a
 *   host-only method, so a guest name fails at the interface guard.
 */
export const httpMk = async ({
  name,
  allowedOrigins,
  maxRequestsPerMinute,
  maxResponseBytes,
  policyMode,
  acknowledgeUnbounded,
  agentNames,
}) => {
  const parsedName = parsePetNamePath(name);
  const policy = makeHttpClientPolicy({
    allowedOrigins,
    maxRequestsPerMinute,
    maxResponseBytes,
    policyMode,
  });

  // A tofu-auto mint voids the very confinement `--origin` appears to promise
  // and Phase 1 ships no inspect/revoke verb to see or undo it, so require an
  // explicit acknowledgment locally — by flag name, before anything crosses
  // CapTP — rather than gating a confinement-nullifying switch behind help
  // prose alone.
  if (policy.policyMode === 'tofu-auto' && !acknowledgeUnbounded) {
    throw new Error(
      '--policy-mode tofu-auto mints an unbounded outbound capability that ' +
        'Phase 1 ships no verb to inspect or revoke; pass ' +
        '--acknowledge-unbounded to confirm, or use --policy-mode strict',
    );
  }

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).provideHttpClient(parsedName, policy);
    console.log(name);
    // Echo the effective bound the operator actually minted: the daemon-verbatim
    // origin allowlist (canonicalized here — IDN punycode, case-fold, default-port
    // strip — so it can differ from what was typed) and the policy mode, since
    // Phase 1 has no inspect verb to reveal it after the fact.
    process.stderr.write(
      `minted ${policy.policyMode ?? 'strict'} HTTP client "${name}" over ` +
        `${policy.allowedOrigins.join(', ')}\n`,
    );
    if (policy.policyMode === 'tofu-auto') {
      process.stderr.write(
        'warning: tofu-auto auto-allows any first-seen origin, so the ' +
          'allowlist above does not bound outbound reach; no revoke verb yet\n',
      );
    }
  });
};

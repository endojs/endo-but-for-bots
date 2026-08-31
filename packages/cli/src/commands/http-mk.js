import os from 'os';

import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';
import { makeHttpClientPolicy } from '../http-mk-policy.js';

const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

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
    // Echo the effective bound the operator actually minted: the CLI's own
    // locally-normalized origin allowlist (canonicalized here — IDN punycode,
    // case-fold, default-port strip — so it can differ from what was typed),
    // policy mode, and explicit-or-default resource bounds. Phase 1 has no
    // inspect verb to reveal them after the fact. This is the shape `mk` sent
    // plus the daemon's documented defaults, not a daemon read-back:
    // `provideHttpClient` returns the minted client capability (discarded here),
    // not the stored policy. The daemon re-normalizes the same origins through
    // `normalizeHttpClientPolicy`, which agrees with this serialization for
    // every accepted origin.
    const maxRequestsPerMinute =
      policy.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
    const maxResponseBytes =
      policy.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    process.stderr.write(
      `minted ${policy.policyMode ?? 'strict'} HTTP client "${name}" over ` +
        `${policy.allowedOrigins.join(', ')}; ` +
        `max ${maxRequestsPerMinute} requests/minute; ` +
        `max ${maxResponseBytes} response bytes\n`,
    );
    if (policy.policyMode === 'tofu-auto') {
      process.stderr.write(
        'warning: tofu-auto auto-allows any first-seen origin, so the ' +
          'allowlist above does not bound outbound reach; no revoke verb yet\n',
      );
    }
  });
};

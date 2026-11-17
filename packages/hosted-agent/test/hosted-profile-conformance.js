// @ts-check
import test from 'ava';

import { HOSTED_AGENT_POLICY_V1 } from '../src/hosted-agent-policy.js';

const imageDigest = `sha256:${'b'.repeat(64)}`;

const row = (role, source, destination, mode) =>
  harden({
    role,
    source,
    destination,
    mode,
    options: harden(['nosuid', 'nodev']),
  });

/**
 * Shared conformance for an adapter's declared hosted profile.
 *
 * The unification's claim is that all three adapters run under one contract
 * and differ only in their mount table. These tests are that claim, checked:
 * the contract is the shared constant verbatim, the table is the adapter's
 * own, and the verifier refuses any table but that one.
 *
 * @param {object} profile
 * @param {string} profile.label
 * @param {readonly any[]} profile.fixedMounts
 * @param {(policy: any, requirements?: any) => any} profile.assertHostedAgentPolicyV1
 */
export const testHostedProfile = ({
  label,
  fixedMounts,
  assertHostedAgentPolicyV1,
}) => {
  const sessionId = 'session-1';
  const attested = () =>
    harden({
      ...HOSTED_AGENT_POLICY_V1,
      imageDigest,
      sessionId,
      networkNamespaceId: 'netns-1',
      mounts: harden(
        fixedMounts.map(mount =>
          row(
            mount.role,
            mount.kind === 'session' ? `${mount.role}:${sessionId}` : 'tmpfs',
            mount.destination,
            mount.mode,
          ),
        ),
      ),
    });

  test(`${label} runs under the shared contract, unmodified`, t => {
    const policy = assertHostedAgentPolicyV1(attested(), {
      imageDigest,
      sessionId,
    });
    for (const [key, value] of Object.entries(HOSTED_AGENT_POLICY_V1)) {
      if (key === 'namespaces' || key === 'limits') {
        t.deepEqual(policy[key], value, key);
      } else {
        t.is(policy[key], value, key);
      }
    }
  });

  test(`${label} declares a table with no nesting and no reserved role`, t => {
    const destinations = fixedMounts.map(mount => mount.destination);
    for (const [index, destination] of destinations.entries()) {
      for (const other of destinations.slice(index + 1)) {
        t.false(
          destination === other ||
            destination.startsWith(`${other}/`) ||
            other.startsWith(`${destination}/`),
          `${destination} and ${other} must not nest`,
        );
      }
    }
    for (const mount of fixedMounts) {
      t.false(mount.role === 'resolver' || mount.role.startsWith('attach-'));
    }
  });

  test(`${label} refuses a table that is not its own`, t => {
    const swapped = attested();
    t.throws(
      () =>
        assertHostedAgentPolicyV1(
          harden({ ...swapped, mounts: harden(swapped.mounts.slice(1)) }),
          { imageDigest, sessionId },
        ),
      { message: /undeclared mount|omitted a required role/ },
      'a missing role is refused',
    );
    t.throws(
      () =>
        assertHostedAgentPolicyV1(
          harden({
            ...swapped,
            mounts: harden([
              ...swapped.mounts,
              row('extra', 'tmpfs', '/extra', 'rw'),
            ]),
          }),
          { imageDigest, sessionId },
        ),
      { message: /undeclared mount/ },
      'an extra row is refused',
    );
  });
};
harden(testHostedProfile);

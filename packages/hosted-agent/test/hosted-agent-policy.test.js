// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  HOSTED_AGENT_POLICY_V1,
  HOSTED_SLICE_RESOURCES,
  assertFixedMounts,
  makeHostedAgentPolicyVerifier,
  sliceWritableBytes,
} from '../src/hosted-agent-policy.js';

const imageDigest = `sha256:${'a'.repeat(64)}`;

/**
 * A second adapter's profile, deliberately unlike Codex's: its CLI home is
 * `/config` rather than `/codex-home`, and it fixes a role deep enough that
 * an attach could be its parent — the reverse-nesting case Codex's own flat
 * table cannot reach.
 */
const CLI_FIXED_MOUNTS = harden([
  { role: 'workspace', kind: 'session', destination: '/workspace', mode: 'rw' },
  { role: 'cli-state', kind: 'session', destination: '/config', mode: 'rw' },
  { role: 'tmp', kind: 'tmpfs', destination: '/tmp', mode: 'rw' },
  { role: 'mcp', kind: 'tmpfs', destination: '/srv/mcp/sockets', mode: 'ro' },
]);

const { assertContainerMounts, assertHostedAgentPolicyV1 } =
  makeHostedAgentPolicyVerifier({ fixedMounts: CLI_FIXED_MOUNTS });

const row = (role, source, destination, mode = 'rw') =>
  harden({
    role,
    source,
    destination,
    mode,
    options: harden(['nosuid', 'nodev']),
  });

const validPolicy = (sessionId = 'session-1') =>
  harden({
    ...HOSTED_AGENT_POLICY_V1,
    imageDigest,
    sessionId,
    networkNamespaceId: 'netns-1',
    mounts: harden([
      row('workspace', `workspace:${sessionId}`, '/workspace'),
      row('cli-state', `cli-state:${sessionId}`, '/config'),
      row('tmp', 'tmpfs', '/tmp'),
      row('mcp', 'tmpfs', '/srv/mcp/sockets', 'ro'),
    ]),
  });

test('the shared verifier attests a second adapter’s fixed table', t => {
  const policy = assertHostedAgentPolicyV1(validPolicy(), {
    imageDigest,
    sessionId: 'session-1',
  });
  t.is(policy.mounts.length, 4);
  // A durable role is named by session, never by host path, whatever backs
  // it — the record says what the session has, not how the host provides it.
  t.deepEqual(
    policy.mounts.map(mount => mount.source),
    ['workspace:session-1', 'cli-state:session-1', 'tmpfs', 'tmpfs'],
  );
  // Codex's table is not this adapter's table, even though every control,
  // namespace and limit in the contract is identical.
  const codexShaped = harden({
    ...validPolicy(),
    mounts: harden([
      row('workspace', 'workspace:session-1', '/workspace'),
      row('codex-state', 'codex-state:session-1', '/codex-home'),
      row('tmp', 'tmpfs', '/tmp'),
      row('mcp', 'tmpfs', '/srv/mcp/sockets', 'ro'),
    ]),
  });
  t.throws(() => assertHostedAgentPolicyV1(codexShaped), {
    message: /exact session table/,
  });
});

test('a fixed role may be shadowed by no attach, at any depth', t => {
  const attach = harden({
    key: 'a1',
    source: '/host/mounts/a1',
    destination: '/mnt/project',
    mode: 'rw',
  });
  t.deepEqual(assertContainerMounts([attach]), [attach]);
  // An attach outside `/mnt/` is admitted: the rule is the property, not the
  // prefix that used to stand in for it.
  t.deepEqual(
    assertContainerMounts([{ ...attach, destination: '/srv/data' }]),
    [{ ...attach, destination: '/srv/data' }],
  );
  /** @type {[string, string, RegExp][]} */
  const shadowed = [
    ['on a fixed role', '/workspace', /shadows the "workspace" role/],
    ['inside a fixed role', '/config/agents', /shadows the "cli-state" role/],
    // The case a flat fixed table cannot produce: the attach is the parent.
    ['around a fixed role', '/srv/mcp', /shadows the "mcp" role/],
    ['around it from higher up', '/srv', /shadows the "mcp" role/],
  ];
  for (const [label, destination, message] of shadowed) {
    t.throws(
      () => assertContainerMounts([{ ...attach, destination }]),
      { message },
      label,
    );
  }
});

test('the resolver row is shadowed by no attach either', t => {
  const attach = harden({
    key: 'a1',
    source: '/host/mounts/a1',
    destination: '/etc',
    mode: 'rw',
  });
  // Without a public network there is no resolver row, so `/etc` is free.
  const attested = harden({
    ...validPolicy(),
    mounts: harden([
      ...validPolicy().mounts,
      row('attach-a1', 'attach:a1', '/etc'),
    ]),
  });
  t.is(
    assertHostedAgentPolicyV1(attested, { containerMounts: [attach] }).mounts
      .length,
    5,
  );
  // With one, the generated nameserver file lives under it.
  const publicPolicy = harden({
    ...validPolicy(),
    networkPolicy: 'public-internet',
    mounts: harden([
      ...validPolicy().mounts,
      row('resolver', 'resolver:public', '/etc/resolv.conf', 'ro'),
      row('attach-a1', 'attach:a1', '/etc'),
    ]),
  });
  t.throws(
    () =>
      assertHostedAgentPolicyV1(publicPolicy, {
        networkPolicy: 'public-internet',
        containerMounts: [attach],
      }),
    { message: /shadows the resolver/ },
  );
});

test('a profile must declare a well-formed fixed table', t => {
  /** @type {[string, unknown, RegExp][]} */
  const rejected = [
    ['nothing at all', undefined, /must declare its fixed mounts/],
    ['an empty table', [], /must declare its fixed mounts/],
    [
      'a reserved role',
      [{ role: 'resolver', kind: 'tmpfs', destination: '/etc', mode: 'ro' }],
      /role "resolver" is reserved/,
    ],
    [
      'an attach role',
      [
        {
          role: 'attach-a1',
          kind: 'tmpfs',
          destination: '/mnt/a1',
          mode: 'rw',
        },
      ],
      /role "attach-a1" is reserved/,
    ],
    [
      'an unknown kind',
      [{ role: 'x', kind: 'volume', destination: '/x', mode: 'rw' }],
      /kind must be/,
    ],
    [
      'a relative destination',
      [{ role: 'x', kind: 'tmpfs', destination: 'x', mode: 'rw' }],
      /absolute normal path/,
    ],
    [
      'nested roles',
      [
        { role: 'a', kind: 'tmpfs', destination: '/srv', mode: 'rw' },
        { role: 'b', kind: 'tmpfs', destination: '/srv/b', mode: 'rw' },
      ],
      /nests with/,
    ],
    [
      'a duplicated role',
      [
        { role: 'a', kind: 'tmpfs', destination: '/a', mode: 'rw' },
        { role: 'a', kind: 'tmpfs', destination: '/b', mode: 'rw' },
      ],
      /role "a" is duplicated/,
    ],
  ];
  for (const [label, fixedMounts, message] of rejected) {
    t.throws(() => assertFixedMounts(fixedMounts), { message }, label);
    t.throws(
      () => makeHostedAgentPolicyVerifier({ fixedMounts }),
      { message },
      `${label}, through the factory`,
    );
  }
});

test('the writable ceiling is a sum over the table, not a profile constant', t => {
  const GiB = 1024n ** 3n;
  const MiB = 1024n ** 2n;
  const mounts = harden([
    { role: 'tmp', kind: 'tmpfs', sizeBytes: GiB },
    { role: 'run', kind: 'tmpfs', sizeBytes: 256n * MiB },
    { role: 'state', kind: 'volume', sizeBytes: 4n * GiB },
    // Neither of these is this slice's storage: the bytes belong to a
    // capability or to the host, bounded where they live. Counting them would
    // attest a ceiling nothing enforces.
    { role: 'workspace', kind: 'attach' },
    { role: 'mcp', kind: 'bind' },
  ]);
  const shm = HOSTED_SLICE_RESOURCES.shmBytes;
  t.is(
    sliceWritableBytes(mounts),
    2n * shm + 2n * GiB + 512n * MiB + 4n * GiB,
    'each tmpfs twice, the volume once, shm twice, the rest not at all',
  );
  t.is(sliceWritableBytes([]), 2n * shm);
  // The profile carries no ceiling of its own: it is not a constant.
  t.false('writableBytes' in HOSTED_SLICE_RESOURCES);
});

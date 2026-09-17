// @ts-check
import '@endo/init';

import test from 'ava';
import { makeExo } from '@endo/exo';
import {
  HostedToolSetInterface,
  assertHostedBackendDescriptor,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';

import {
  HOSTED_AGENT_POLICY_V1,
  assertProviderGrantV1,
  assertContainerMounts,
  assertHostedAgentPolicyV1,
  normalizeCodexModelDescriptor,
} from '../backend-factory.js';

const validPolicy = () =>
  harden({
    ...HOSTED_AGENT_POLICY_V1,
    sessionId: 'session-1',
    networkNamespaceId: 'netns-session-1',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    mounts: harden([
      harden({
        role: 'workspace',
        destination: '/workspace',
        mode: 'rw',
        source: 'workspace:session-1',
        options: harden(['nosuid', 'nodev']),
      }),
      harden({
        role: 'codex-state',
        destination: '/codex-home',
        mode: 'rw',
        source: 'codex-state:session-1',
        options: harden(['nosuid', 'nodev']),
      }),
      harden({
        role: 'tmp',
        destination: '/tmp',
        mode: 'rw',
        source: 'tmpfs',
        options: harden(['nosuid', 'nodev']),
      }),
      harden({
        role: 'run',
        destination: '/run',
        mode: 'rw',
        source: 'tmpfs',
        options: harden(['nosuid', 'nodev']),
      }),
      harden({
        role: 'scratch',
        destination: '/scratch',
        mode: 'rw',
        source: 'tmpfs',
        options: harden(['nosuid', 'nodev']),
      }),
    ]),
  });

const imageDigest = `sha256:${'a'.repeat(64)}`;
const providerOrigin = 'https://api.openai.com';
const accountRef = 'operator-account-1';

const validLeaseRequirements = () => ({
  sessionId: 'session-1',
  imageDigest,
  networkNamespaceId: 'netns-session-1',
  providerOrigin,
  accountRef,
});

const validLease = () =>
  harden({
    version: 'ProviderGrantV1',
    grantId: 'lease-session-1',
    sessionId: 'session-1',
    imageDigest,
    networkNamespaceId: 'netns-session-1',
    providerOrigin,
    endpoint: 'http://127.0.0.1:4317/',
    accountRef,
    authMode: 'api-key',
    modelAllowlist: harden(['gpt-test']),
  });

const makeToolSet = () =>
  makeExo('TestHostedToolSet', HostedToolSetInterface, {
    async describe() {
      return harden({ dynamicTools: [], toolSetId: 'none' });
    },
    async execute() {
      return '';
    },
    help() {
      return 'Test hosted tool set.';
    },
  });

const ATTACH_DECLARED = harden({
  key: 'a1',
  source: '/host/mounts/claude-attach-a1',
  destination: '/mnt/project',
  mode: 'rw',
});
const attachRow = (overrides = {}) =>
  harden({
    role: 'attach-a1',
    destination: '/mnt/project',
    mode: 'rw',
    source: 'attach:a1',
    options: harden(['nosuid', 'nodev']),
    ...overrides,
  });

test('sandbox contract rejects a tag and an unenforced resource limit', t => {
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({ ...validPolicy(), imageDigest: 'localhost/codex:latest' }),
      ),
    { message: /pinned by SHA-256 digest/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({
          ...validPolicy(),
          limits: harden({ ...validPolicy().limits, pids: null }),
        }),
      ),
    { message: /limit.*pids.*not enforced/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(validPolicy(), {
        imageDigest: `sha256:${'b'.repeat(64)}`,
      }),
    { message: /not operator-approved/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({
          ...validPolicy(),
          mounts: harden([
            ...validPolicy().mounts,
            harden({
              role: 'secret',
              destination: '/secrets',
              mode: 'ro',
              source: '/home/operator',
              options: harden(['nosuid', 'nodev']),
            }),
          ]),
        }),
      ),
    { message: /undeclared mount/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({
          ...validPolicy(),
          mounts: harden([
            ...validPolicy().mounts.slice(1),
            harden({
              role: '__proto__',
              destination: undefined,
              mode: undefined,
              source: undefined,
              options: harden(['nosuid', 'nodev']),
            }),
          ]),
        }),
      ),
    { message: /exact session table/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({ ...validPolicy(), privilegedEscapeHatch: true }),
      ),
    { message: /unknown or missing fields/ },
  );
});

test('hosted descriptors cannot smuggle authority into Floot metadata', t => {
  t.throws(
    () =>
      assertHostedBackendDescriptor(
        harden({
          id: 'bad',
          title: 'Bad backend',
          kind: 'hosted',
          continuity: 'opaque',
          toolOwnership: 'endo',
          metadata: makeToolSet(),
        }),
      ),
    { message: /must be a record/ },
  );
  t.throws(
    () =>
      normalizeHostedModelDescriptor(
        harden({
          id: 'bad-model',
          title: 'Bad model',
          description: '',
          default: false,
          defaultReasoningEffort: null,
          reasoningEfforts: harden([makeToolSet()]),
        }),
      ),
    { message: /invalid reasoning efforts/ },
  );
});

test('Codex model schema is translated at the backend boundary', t => {
  t.deepEqual(
    normalizeCodexModelDescriptor(
      harden({
        id: 'gpt-test',
        displayName: 'GPT Test',
        description: 'Pinned schema fixture',
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: harden([
          harden({ reasoningEffort: 'low' }),
          harden({ reasoningEffort: 'medium' }),
        ]),
      }),
    ),
    {
      id: 'gpt-test',
      title: 'GPT Test',
      description: 'Pinned schema fixture',
      default: true,
      defaultReasoningEffort: 'medium',
      reasoningEfforts: ['low', 'medium'],
    },
  );
});

test('broker lease is bound to session, namespace, and model', t => {
  t.deepEqual(
    assertProviderGrantV1(validLease(), {
      ...validLeaseRequirements(),
      model: 'gpt-test',
    }),
    validLease(),
  );
  t.throws(
    () =>
      assertProviderGrantV1(
        harden({ ...validLease(), networkNamespaceId: 'shared-netns' }),
        validLeaseRequirements(),
      ),
    { message: /identity does not match/ },
  );
  for (const endpoint of [
    'http://bearer@127.0.0.1:4317/',
    'http://user:secret@127.0.0.1:4317/',
  ]) {
    t.throws(
      () =>
        assertProviderGrantV1(
          harden({ ...validLease(), endpoint }),
          validLeaseRequirements(),
        ),
      { message: /provider-bound loopback/ },
    );
  }
  for (const replacement of [
    { providerOrigin: 'https://attacker.invalid' },
    { accountRef: 'wrong-account' },
  ]) {
    t.throws(
      () =>
        assertProviderGrantV1(
          harden({ ...validLease(), ...replacement }),
          validLeaseRequirements(),
        ),
      { message: /identity does not match/ },
    );
  }
});

test('assertContainerMounts admits a bounded declaration and nothing else', t => {
  t.deepEqual(assertContainerMounts(undefined), []);
  t.deepEqual(assertContainerMounts([ATTACH_DECLARED]), [ATTACH_DECLARED]);
  /** @type {[string, unknown, RegExp][]} */
  const rejected = [
    ['not an array', {}, /must be an array/],
    [
      'an extra field',
      { ...ATTACH_DECLARED, cap: {} },
      /unknown or missing fields/,
    ],
    [
      'a key outside the alphabet',
      { ...ATTACH_DECLARED, key: '../x' },
      /not a portable key/,
    ],
    [
      'a relative source',
      { ...ATTACH_DECLARED, source: 'x' },
      /host mountpoint/,
    ],
    [
      'a destination that shadows a fixed role',
      { ...ATTACH_DECLARED, destination: '/workspace' },
      /shadows the "workspace" role/,
    ],
    [
      'a destination inside a fixed role',
      { ...ATTACH_DECLARED, destination: '/codex-home/config' },
      /shadows the "codex-state" role/,
    ],
    [
      'a relative destination',
      { ...ATTACH_DECLARED, destination: 'mnt/project' },
      /destination must be an absolute normal path/,
    ],
    [
      'a destination with a traversal segment',
      { ...ATTACH_DECLARED, destination: '/mnt/../etc' },
      /destination must be an absolute normal path/,
    ],
    ['an unknown mode', { ...ATTACH_DECLARED, mode: 'rwx' }, /mode must be/],
  ];
  for (const [label, bad, message] of rejected) {
    // The first row hands the non-array in directly; every other row is one
    // malformed entry inside an otherwise well-formed list.
    const candidates =
      typeof bad === 'object' && bad !== null && Object.keys(bad).length === 0
        ? bad
        : [bad];
    t.throws(() => assertContainerMounts(candidates), { message }, label);
  }
  t.throws(
    () =>
      assertContainerMounts([
        ATTACH_DECLARED,
        {
          ...ATTACH_DECLARED,
          destination: '/mnt/other',
          source: '/host/mounts/other',
        },
      ]),
    { message: /key.*duplicated/ },
  );
  t.throws(
    () =>
      assertContainerMounts([
        ATTACH_DECLARED,
        { ...ATTACH_DECLARED, key: 'a2', source: '/host/mounts/other' },
      ]),
    { message: /destination.*duplicated/ },
  );
});

test('the attested table is the five roles plus exactly the declared attaches', t => {
  const withAttach = harden({
    ...validPolicy(),
    mounts: harden([...validPolicy().mounts, attachRow()]),
  });
  // Declared and present: attested, in its declared mode.
  const policy = assertHostedAgentPolicyV1(withAttach, {
    containerMounts: [ATTACH_DECLARED],
  });
  t.is(policy.mounts.length, 6);
  const ro = assertHostedAgentPolicyV1(
    harden({
      ...validPolicy(),
      mounts: harden([...validPolicy().mounts, attachRow({ mode: 'ro' })]),
    }),
    { containerMounts: [{ ...ATTACH_DECLARED, mode: 'ro' }] },
  );
  t.is(ro.mounts.at(-1)?.mode, 'ro');

  // Present but not declared: the undeclared mount the check exists for.
  t.throws(() => assertHostedAgentPolicyV1(withAttach), {
    message: /undeclared mount/,
  });
  // Declared but absent from the table.
  t.throws(
    () =>
      assertHostedAgentPolicyV1(validPolicy(), {
        containerMounts: [ATTACH_DECLARED],
      }),
    { message: /undeclared mount/ },
  );
  // Declared read-only, attested read-write: the mode is part of the claim.
  t.throws(
    () =>
      assertHostedAgentPolicyV1(withAttach, {
        containerMounts: [{ ...ATTACH_DECLARED, mode: 'ro' }],
      }),
    { message: /exact session table/ },
  );
  // A row under a declared key at the wrong destination.
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({
          ...validPolicy(),
          mounts: harden([
            ...validPolicy().mounts,
            attachRow({ destination: '/mnt/elsewhere' }),
          ]),
        }),
        { containerMounts: [ATTACH_DECLARED] },
      ),
    { message: /exact session table/ },
  );
});

test('assertContainerMounts validates every entry it counts, and refuses nesting', t => {
  // A sparse array: `map` would skip the holes and return a list whose
  // `length` counts entries no check ever saw — and that length is what the
  // attested table is sized against, so the holes would reach the slice
  // request as `undefined` mount rows.
  t.throws(
    () => assertContainerMounts(new Array(3)),
    { message: /unknown or missing fields/ },
    'array holes are entries, not gaps',
  );
  // Built rather than written as a sparse literal, which lint forbids.
  const withHole = new Array(3);
  withHole[0] = ATTACH_DECLARED;
  withHole[2] = ATTACH_DECLARED;
  t.throws(
    () => assertContainerMounts(withHole),
    { message: /unknown or missing fields/ },
    'a hole between well-formed entries is still refused',
  );

  // Nested destinations are each declared and each attested, but the
  // attested table has no ordering, so it cannot say which projection the
  // slice sees at the shadowed path.
  t.throws(
    () =>
      assertContainerMounts([
        ATTACH_DECLARED,
        harden({
          key: 'b2',
          source: '/host/mounts/claude-attach-b2',
          destination: `${ATTACH_DECLARED.destination}/inner`,
          mode: 'ro',
        }),
      ]),
    { message: /nests with/ },
  );
});

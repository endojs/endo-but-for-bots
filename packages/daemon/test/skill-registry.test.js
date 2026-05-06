// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import {
  listSkills,
  publishSkill,
  readSkillDescriptor,
  skillCodeName,
  skillRequiresName,
} from '../src/skill-registry.js';

/**
 * Build an in-memory mock of the directory subset the skill-registry
 * helpers depend on (`has`, `list`, `lookup`, `readText`, `writeText`,
 * `makeDirectory`, `remove`, `move`). The mock keeps the test free of
 * daemon fork/teardown overhead while still exercising the same public
 * API surface that an EndoDirectory exposes over CapTP.
 *
 * @param {object} [hooks]
 * @param {(path: Array<string>, name: string, value: string) => void} [hooks.beforeWriteText]
 *   Called before every `writeText` on this directory or any sub-directory
 *   created via `makeDirectory`. Throwing from the hook simulates a
 *   mid-publish write failure. The first argument is the chain of names
 *   from the root mock (so the hook can target writes inside a particular
 *   staging or requires sub-directory).
 * @param {Array<string>} [parentPath] - Internal: chain of pet names from
 *   the root of the mock to this directory. Used to give nested
 *   `writeText` calls a stable identity for the `beforeWriteText` hook.
 */
const makeMockDirectory = (hooks = {}, parentPath = []) => {
  /** @type {Map<string, { kind: 'text', value: string } | { kind: 'dir', dir: any }>} */
  const entries = new Map();

  const directory = Far('MockDirectory', {
    has: async name => entries.has(name),
    list: async () => harden([...entries.keys()].sort()),
    lookup: async name => {
      const entry = entries.get(name);
      if (entry === undefined) {
        throw new Error(`Unknown ${name}`);
      }
      if (entry.kind === 'text') {
        return Far('TextValue', { text: async () => entry.value });
      }
      return entry.dir;
    },
    readText: async name => {
      const entry = entries.get(name);
      if (entry === undefined || entry.kind !== 'text') {
        throw new Error(`Not text: ${name}`);
      }
      return entry.value;
    },
    writeText: async (name, value) => {
      if (hooks.beforeWriteText) {
        hooks.beforeWriteText(parentPath, name, value);
      }
      entries.set(name, { kind: 'text', value });
    },
    makeDirectory: async name => {
      const dir = makeMockDirectory(hooks, [...parentPath, name]);
      entries.set(name, { kind: 'dir', dir });
      return dir;
    },
    remove: async name => {
      entries.delete(name);
    },
    // EndoDirectory.move signature is (fromPath, toPath) where each path
    // is a string array. The skill-registry only ever uses single-segment
    // paths within the same hub (renaming the staging directory onto the
    // target name), so the mock implements only that case.
    move: async (fromPath, toPath) => {
      const [from] = fromPath;
      const [to] = toPath;
      const entry = entries.get(from);
      if (entry === undefined) {
        throw new Error(`Unknown ${from}`);
      }
      entries.delete(from);
      entries.set(to, entry);
    },
    // Expose for white-box assertions.
    inspect: () => entries,
    storeIdentifier: async (_name, _id) => {
      throw new Error('not implemented in mock');
    },
  });

  return directory;
};

test('listSkills returns names of registry entries', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'gmail-bridge', { description: 'gmail' });
  await publishSkill(registry, 'telegram-bridge', { description: 'tg' });

  const names = await listSkills(registry);
  t.deepEqual(names, ['gmail-bridge', 'telegram-bridge']);
});

test('readSkillDescriptor returns metadata fields', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'gmail-bridge', {
    description: 'Read and manage Gmail via OAuth',
    version: '1.0.0',
    author: 'endo-community',
    homepage: 'https://example.test/gmail-bridge',
  });

  const descriptor = await readSkillDescriptor(registry, 'gmail-bridge');
  t.is(descriptor.name, 'gmail-bridge');
  t.is(descriptor.description, 'Read and manage Gmail via OAuth');
  t.is(descriptor.version, '1.0.0');
  t.is(descriptor.author, 'endo-community');
  t.is(descriptor.homepage, 'https://example.test/gmail-bridge');
  t.deepEqual(descriptor.requires, {});
  t.false(descriptor.hasCode);
});

test('readSkillDescriptor enumerates the requires sub-directory', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'gmail-bridge', {
    description: 'Gmail bridge',
    requires: {
      oauth: 'gmail',
      'network-fetch': 'https://gmail.googleapis.com',
    },
  });

  const descriptor = await readSkillDescriptor(registry, 'gmail-bridge');
  t.deepEqual(descriptor.requires, {
    oauth: 'gmail',
    'network-fetch': 'https://gmail.googleapis.com',
  });
});

test('readSkillDescriptor reports omitted metadata as undefined', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'minimal', {});

  const descriptor = await readSkillDescriptor(registry, 'minimal');
  t.is(descriptor.description, undefined);
  t.is(descriptor.version, undefined);
  t.is(descriptor.author, undefined);
  t.is(descriptor.homepage, undefined);
  t.deepEqual(descriptor.requires, {});
  t.false(descriptor.hasCode);
});

test('readSkillDescriptor reports presence of a code entry', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'with-code', { description: 'has code' });
  // Simulate an external `storeIdentifier` of an installable module under
  // the well-known `code` pet name. The helper does not place the entry;
  // the publisher does so out of band.
  const descriptor = await registry.lookup('with-code');
  await descriptor.writeText(skillCodeName, 'pretend this is a module');

  const read = await readSkillDescriptor(registry, 'with-code');
  t.true(read.hasCode);
});

test('readSkillDescriptor rejects an unknown skill', async t => {
  const registry = makeMockDirectory();
  await t.throwsAsync(readSkillDescriptor(registry, 'nope'), {
    message: /No skill named "nope" in registry/,
  });
});

test('publishSkill rejects unknown top-level fields', async t => {
  const registry = makeMockDirectory();
  await t.throwsAsync(
    publishSkill(registry, 'gmail-bridge', {
      // @ts-expect-error intentional typo
      descrtiption: 'typo',
    }),
    { message: /Unknown skill field "descrtiption"/ },
  );
});

test('publishSkill rejects a non-string scope hint', async t => {
  const registry = makeMockDirectory();
  await t.throwsAsync(
    publishSkill(registry, 'gmail-bridge', {
      requires: {
        // @ts-expect-error intentional bad type
        oauth: 42,
      },
    }),
    { message: /Requirement scope "oauth" must be a string/ },
  );
});

test('publishSkill rejects an empty name', async t => {
  const registry = makeMockDirectory();
  await t.throwsAsync(publishSkill(registry, '', { description: 'x' }), {
    message: /Skill name must be a non-empty string/,
  });
});

test('publishSkill is idempotent and replaces a prior descriptor', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'gmail-bridge', {
    description: 'first',
    version: '0.1.0',
  });
  await publishSkill(registry, 'gmail-bridge', {
    description: 'second',
    version: '1.0.0',
  });

  const descriptor = await readSkillDescriptor(registry, 'gmail-bridge');
  t.is(descriptor.description, 'second');
  t.is(descriptor.version, '1.0.0');

  // Republish with a smaller field set drops the previous extra fields
  // because the descriptor directory is recreated rather than merged.
  await publishSkill(registry, 'gmail-bridge', {
    description: 'third',
  });
  const reread = await readSkillDescriptor(registry, 'gmail-bridge');
  t.is(reread.description, 'third');
  t.is(reread.version, undefined);
});

test('publishSkill creates the requires sub-directory only when needed', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'no-reqs', { description: 'simple' });
  const descriptor = await registry.lookup('no-reqs');
  t.false(await descriptor.has(skillRequiresName));

  await publishSkill(registry, 'with-reqs', {
    description: 'needs net',
    requires: { 'network-fetch': 'https://example.test' },
  });
  const reqDescriptor = await registry.lookup('with-reqs');
  t.true(await reqDescriptor.has(skillRequiresName));
});

// Adversarial: a descriptor that carries spurious sibling entries
// (e.g. a publisher's experimental field, or a leftover from a prior
// schema) must still produce the well-known metadata fields and must
// not leak the spurious entries through SkillDescriptor.
test('readSkillDescriptor ignores spurious sibling entries on a descriptor', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'gmail-bridge', {
    description: 'bridge',
    version: '1.0.0',
  });
  // Publisher wrote a non-conventional entry directly on the
  // descriptor directory after publishSkill returned.
  const descriptor = await registry.lookup('gmail-bridge');
  await descriptor.writeText('experimental-tag', 'beta');

  const read = await readSkillDescriptor(registry, 'gmail-bridge');
  t.is(read.description, 'bridge');
  t.is(read.version, '1.0.0');
  // The spurious key does not surface as a top-level metadata field
  // (the typedef pins which keys exist), and it does not leak into
  // the requires record.
  t.deepEqual(Object.keys(read.requires), []);
});

// Adversarial: an explicit empty `requires` object publishes an empty
// requires directory; reading back must reflect "no requirements" rather
// than throwing or returning undefined.
test('publishSkill with empty requires creates an empty requires directory', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'no-deps', {
    description: 'standalone skill',
    requires: {},
  });

  const descriptor = await registry.lookup('no-deps');
  t.true(await descriptor.has(skillRequiresName));
  const requiresDir = await descriptor.lookup(skillRequiresName);
  t.deepEqual(await requiresDir.list(), []);

  const read = await readSkillDescriptor(registry, 'no-deps');
  t.deepEqual(read.requires, {});
});

// Adversarial: a `requires` entry with an empty-string scope hint
// (publisher's deliberate "no scope" signal) round-trips as the empty
// string rather than being coerced to undefined or filtered out.
test('readSkillDescriptor preserves empty-string scope hints', async t => {
  const registry = makeMockDirectory();
  await publishSkill(registry, 'open-net', {
    requires: { 'network-fetch': '' },
  });
  const read = await readSkillDescriptor(registry, 'open-net');
  t.deepEqual(read.requires, { 'network-fetch': '' });
});

// publishSkill is staged: a writeText failure mid-publish must not
// destroy the prior descriptor. The caller observes either the prior
// descriptor (failure case) or the new descriptor (success), never a
// half-populated descriptor under the published name.
test('publishSkill preserves the prior descriptor when staging fails', async t => {
  // The hook fires on every writeText. The flag below is flipped after
  // the first (known-good) publish, so only the second (re-publish)
  // sees the simulated failure.
  let armFailure = false;
  const hooks = {
    beforeWriteText: (parentPath, name, _value) => {
      if (
        armFailure &&
        parentPath[parentPath.length - 1] === 'gmail-bridge.staging' &&
        name === 'version'
      ) {
        throw new Error('simulated mid-publish failure');
      }
    },
  };
  const registry = makeMockDirectory(hooks);

  // First, publish a known-good descriptor.
  await publishSkill(registry, 'gmail-bridge', {
    description: 'first version',
    version: '1.0.0',
    author: 'first author',
  });

  // Confirm the descriptor reads back as expected before the failed
  // re-publish attempt.
  const before = await readSkillDescriptor(registry, 'gmail-bridge');
  t.is(before.description, 'first version');
  t.is(before.version, '1.0.0');
  t.is(before.author, 'first author');

  // Arm the failure for the second publish.
  armFailure = true;

  await t.throwsAsync(
    publishSkill(registry, 'gmail-bridge', {
      description: 'second version',
      version: '2.0.0',
      author: 'second author',
    }),
    { message: /simulated mid-publish failure/ },
  );

  // The published descriptor must still be the first version. The
  // failed publish must not have overwritten or partly-overwritten it.
  const after = await readSkillDescriptor(registry, 'gmail-bridge');
  t.is(after.description, 'first version');
  t.is(after.version, '1.0.0');
  t.is(after.author, 'first author');

  // The staging directory must have been cleaned up; only the published
  // name should be visible to a subsequent listSkills.
  const names = await listSkills(registry);
  t.deepEqual(names, ['gmail-bridge']);
});

// Even after a failed publish leaves a staging directory behind (e.g.
// the cleanup itself crashed), a subsequent successful publishSkill for
// the same name reclaims the staging slot and proceeds. The replay
// path is part of the contract.
test('publishSkill reclaims a leftover staging directory on retry', async t => {
  const registry = makeMockDirectory();

  // Manually create a staging directory to simulate a leftover from a
  // crashed prior publish.
  await registry.makeDirectory('gmail-bridge.staging');
  const stagingBefore = await registry.lookup('gmail-bridge.staging');
  await stagingBefore.writeText('description', 'leftover from prior publish');

  // A fresh publishSkill for the same name reclaims the staging slot
  // and writes the new descriptor.
  await publishSkill(registry, 'gmail-bridge', {
    description: 'fresh publish',
    version: '2.0.0',
  });

  const read = await readSkillDescriptor(registry, 'gmail-bridge');
  t.is(read.description, 'fresh publish');
  t.is(read.version, '2.0.0');

  // No staging directory should remain after a successful publish.
  t.false(await registry.has('gmail-bridge.staging'));
});

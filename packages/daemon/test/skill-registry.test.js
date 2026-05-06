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
 * `makeDirectory`, `remove`). The mock keeps the test free of daemon
 * fork/teardown overhead while still exercising the same public API
 * surface that an EndoDirectory exposes over CapTP.
 */
const makeMockDirectory = () => {
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
      entries.set(name, { kind: 'text', value });
    },
    makeDirectory: async name => {
      const dir = makeMockDirectory();
      entries.set(name, { kind: 'dir', dir });
      return dir;
    },
    remove: async name => {
      entries.delete(name);
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

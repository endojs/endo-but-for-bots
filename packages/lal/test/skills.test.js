// @ts-nocheck
/**
 * Lal's Agent Skills wiring: loading from `agent-skills`, the prompt
 * section, reloading between rounds, the 200-skill cap, and `/skill:`
 * expansion in the inbox loop.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { makePiAgent } from '@endo/agentry/harness';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { capSkills, makeAgentSkills } from '../skills.js';
import { setSkillsSection } from '../agent.js';
import { runInboxLoop } from '../inbox-loop.js';

/** An async iterator the test pushes values into. */
const makeChannel = () => {
  const values = [];
  const waiters = [];
  let closed = false;
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    },
    iterator: {
      next() {
        if (values.length > 0) {
          return Promise.resolve({ value: values.shift(), done: false });
        }
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => waiters.push(resolve));
      },
      return() {
        closed = true;
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    },
  };
};

const skillText = (name, description, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`;

/** A read-only mount of a directory of skill directories. */
const makeMount = files => ({
  list: async () => Object.keys(files),
  has: async (entry, fileName) =>
    fileName === 'SKILL.md' && files[entry] !== undefined,
  readText: async ([entry, fileName]) => {
    if (fileName !== 'SKILL.md' || files[entry] === undefined) {
      throw Error(`No file ${entry}/${fileName}`);
    }
    return files[entry];
  },
});

/** Guest powers holding an `agent-skills` directory of mounts. */
const makePowers = (initialMounts = {}) => {
  const state = { mounts: initialMounts ? { ...initialMounts } : undefined };
  const directoryChanges = [];
  const rootChanges = [];
  const powers = {
    has: async name => name === 'agent-skills' && state.mounts !== undefined,
    list: async name => {
      if (name !== 'agent-skills' || !state.mounts) throw Error('no');
      return Object.keys(state.mounts);
    },
    lookup: async path => {
      const [head, entry] = Array.isArray(path) ? path : [path];
      if (head !== 'agent-skills' || !state.mounts?.[entry]) {
        throw Error(`Unknown ${path}`);
      }
      return state.mounts[entry];
    },
    followNameChanges: (...path) => {
      const channel = makeChannel();
      (path.length ? directoryChanges : rootChanges).push(channel);
      return readerFromIterator(channel.iterator);
    },
    /** Add a source and announce it, as the daemon would. */
    addSource(entry, mount) {
      state.mounts[entry] = mount;
      for (const channel of directoryChanges) channel.push({ add: entry });
    },
  };
  return { powers, directoryChanges, rootChanges };
};

const quiet = { log: () => {}, warn: () => {} };

const tick = async (n = 20) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};

test('loads skills from agent-skills with pet-name locations', async t => {
  const { powers } = makePowers({
    '10-user': makeMount({ alpha: skillText('alpha', 'Does alpha things.') }),
  });
  const skills = makeAgentSkills({ powers, ...quiet });
  await skills.start();
  const section = skills.promptSection();
  t.true(section.includes('<name>alpha</name>'));
  t.true(
    section.includes(
      '<location>agent-skills/10-user/alpha/SKILL.md</location>',
    ),
  );
  t.true(section.includes('readText('));
});

test('an agent without agent-skills has no skills section', async t => {
  const { powers } = makePowers(null);
  const skills = makeAgentSkills({ powers, ...quiet });
  await skills.start();
  t.is(skills.promptSection(), '');
});

test('a disable-model-invocation skill is absent from the prompt but expands by command', async t => {
  const { powers } = makePowers({
    '10-user': makeMount({
      hidden: skillText(
        'hidden',
        'Only by command.',
        'disable-model-invocation: true\n',
      ),
      shown: skillText('shown', 'Listed.'),
    }),
  });
  const skills = makeAgentSkills({ powers, ...quiet });
  await skills.start();
  t.false(skills.promptSection().includes('hidden'));
  t.true(skills.promptSection().includes('<name>shown</name>'));
  const expanded = await skills.expand('/skill:hidden with args');
  t.true(expanded.includes('Body of hidden.'));
  t.true(expanded.endsWith('with args'));
  t.is(await skills.expand('hello'), undefined);
  await t.throwsAsync(() => skills.expand('/skill:nope'), {
    message: /Unknown skill "nope"/,
  });
});

test('expansion rereads the current body', async t => {
  const files = { alpha: skillText('alpha', 'A.') };
  const { powers } = makePowers({ '10-user': makeMount(files) });
  const skills = makeAgentSkills({ powers, ...quiet });
  await skills.start();
  files.alpha = skillText('alpha', 'A.').replace('Body of', 'Edited body of');
  t.true(
    (await skills.expand('/skill:alpha')).includes('Edited body of alpha'),
  );
});

test('cap lists at most the limit in precedence order and warns for the rest', async t => {
  const warnings = [];
  const { powers } = makePowers({
    '10-user': makeMount({
      a: skillText('a', 'A.'),
      b: skillText('b', 'B.'),
    }),
    '20-project': makeMount({ c: skillText('c', 'C.') }),
  });
  const skills = makeAgentSkills({
    powers,
    log: () => {},
    warn: message => warnings.push(message),
    maxSkills: 2,
  });
  await skills.start();
  const section = skills.promptSection();
  t.true(section.includes('<name>c</name>'), 'highest precedence kept');
  t.true(section.includes('<name>a</name>'));
  t.false(section.includes('<name>b</name>'));
  t.is(warnings.length, 1);
  t.regex(warnings[0], /1 more omitted.*: b$/);
  // Diagnostics never reach the prompt.
  t.false(section.includes('omitted'));
});

test('capSkills defaults to 200', t => {
  const many = Array.from({ length: 205 }, (_, i) => ({
    name: `s${String(i).padStart(3, '0')}`,
    source: 'agent-skills/10-user',
    disableModelInvocation: false,
  }));
  const { listed, omitted } = capSkills(many);
  t.is(listed.length, 200);
  t.is(omitted.length, 5);
});

test('an added agent-skills entry changes the next round, not the current one', async t => {
  const { powers } = makePowers({
    '10-user': makeMount({ alpha: skillText('alpha', 'A.') }),
  });
  const skills = makeAgentSkills({ powers, ...quiet });
  await skills.start();
  skills.follow();
  await tick();

  const piAgent = makePiAgent({
    systemPrompt: 'You are Lal.',
    model: undefined,
    tools: [],
  });
  setSkillsSection(piAgent, skills.promptSection());
  const roundOnePrompt = piAgent.state.systemPrompt;
  t.true(roundOnePrompt.startsWith('You are Lal.'));
  t.true(roundOnePrompt.includes('<name>alpha</name>'));

  // A source arrives while round one runs: its prompt is fixed already.
  powers.addSource('20-project', makeMount({ beta: skillText('beta', 'B.') }));
  await tick();
  t.is(piAgent.state.systemPrompt, roundOnePrompt);
  t.false(skills.promptSection().includes('beta'));

  // Between rounds, the reload applies to round two.
  t.true(await skills.refresh());
  setSkillsSection(piAgent, skills.promptSection());
  const roundTwoPrompt = piAgent.state.systemPrompt;
  t.true(roundTwoPrompt.includes('<name>beta</name>'));
  t.true(roundTwoPrompt.includes('<name>alpha</name>'));
  t.is(roundTwoPrompt.split('<available_skills>').length, 2, 'replaced');
  t.false(await skills.refresh(), 'no change, no reload');
  skills.stop();
});

test('a name change that leaves the entries as they were reloads nothing', async t => {
  const { powers, directoryChanges } = makePowers({
    '10-user': makeMount({ alpha: skillText('alpha', 'A.') }),
  });
  const logs = [];
  const skills = makeAgentSkills({
    powers,
    log: message => logs.push(message),
    warn: () => {},
  });
  await skills.start();
  skills.follow();
  await tick();
  // The daemon replays existing names when a follower starts.
  for (const channel of directoryChanges) {
    channel.push({ add: '10-user' });
  }
  await tick();
  t.false(await skills.refresh());
  t.is(logs.length, 1);
  skills.stop();
});

/** Guest powers for the inbox loop, plus the skills mounts. */
const makeInboxPowers = mounts => {
  const { powers } = makePowers(mounts);
  const inbox = makeChannel();
  const replies = [];
  Object.assign(powers, {
    send: async () => {},
    locate: async () => 'self',
    followMessages: () => readerFromIterator(inbox.iterator),
    reply: async (number, strings) => {
      replies.push({ number, strings });
    },
  });
  return { powers, inbox, replies };
};

const runLoopWith = async ({ powers, inbox }, messages) => {
  const skills = makeAgentSkills({ powers, ...quiet });
  await skills.start();
  const rounds = [];
  const done = runInboxLoop({
    powers,
    getCancelled: async () => null,
    runOneRound: async prompt => {
      rounds.push(prompt);
    },
    expandCommand: text => skills.expand(text),
  });
  for (const message of messages) inbox.push(message);
  inbox.close();
  await done;
  return rounds;
};

test('/skill: on an unknown name replies with an error and runs no round', async t => {
  const fixture = makeInboxPowers({
    '10-user': makeMount({ alpha: skillText('alpha', 'A.') }),
  });
  const rounds = await runLoopWith(fixture, [
    { from: 'host', number: 1n, type: 'package', strings: ['/skill:nope go'] },
  ]);
  t.deepEqual(rounds, []);
  t.is(fixture.replies.length, 1);
  t.is(fixture.replies[0].number, 1n);
  t.regex(fixture.replies[0].strings[0], /Unknown skill "nope"/);
});

test('/skill: on a known name runs a round with the expanded text', async t => {
  const fixture = makeInboxPowers({
    '10-user': makeMount({
      hidden: skillText('hidden', 'H.', 'disable-model-invocation: true\n'),
    }),
  });
  const rounds = await runLoopWith(fixture, [
    {
      from: 'host',
      number: 2n,
      type: 'package',
      strings: ['/skill:hidden do it'],
    },
    { from: 'host', number: 3n, type: 'package', strings: ['hello'] },
  ]);
  t.is(rounds.length, 2);
  t.true(rounds[0].includes('<skill name="hidden"'));
  t.true(rounds[0].includes('Body of hidden.'));
  t.true(rounds[0].endsWith('do it'));
  t.false(rounds[1].includes('<skill'));
  t.deepEqual(fixture.replies, []);
});

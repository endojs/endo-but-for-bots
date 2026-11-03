// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { main } from '../setup.js';

const owner = ['@pins', 'installations', 'workflow'];
const specifier = new URL('../src/index.js', import.meta.url).href;
const key = path => path.flat().join('/');
const ref = identifier => ({ kind: 'reference', identifier });

/** @param {boolean} [installed] */
const fixture = (installed = false) => {
  const bindings = new Map([['@pins', 'pins']]);
  const formulas = new Map([
    ['pins', { type: 'directory', properties: {} }],
    ['state', { type: 'guest', properties: { handle: ref('handle') } }],
    ['handle', { type: 'handle', properties: {} }],
    [
      'service',
      {
        type: 'make-unconfined',
        properties: {
          powers: ref('state'),
          specifier: { kind: 'literal', value: specifier },
        },
      },
    ],
  ]);
  if (installed)
    for (const [name, id] of [
      ['workflow-agent', 'state'],
      ['workflow-powers', 'handle'],
      ['workflow-service', 'service'],
      ['@pins/workflow-service', 'service'],
    ])
      bindings.set(name, id);
  let creates = 0;
  /** @type {string | undefined} */
  let failRemove;
  /** @type {undefined | ((from: string[]) => void)} */
  let afterCopy;
  const agent = {
    has: (...path) => {
      for (let n = 1; n < path.length; n += 1) {
        if (!bindings.has(key(path.slice(0, n)))) throw Error('Missing parent');
      }
      return bindings.has(key(path));
    },
    identify: (...path) => bindings.get(key(path)),
    diagnostics: () => ({ getFormula: id => formulas.get(id) }),
    makeDirectory: path => {
      const id = `directory-${bindings.size}`;
      bindings.set(key(path), id);
      formulas.set(id, { type: 'directory', properties: {} });
    },
    provideDirectory: path => {
      if (!bindings.has(key(path))) agent.makeDirectory(path);
    },
    copy: (from, to) => {
      const id = bindings.get(key(from));
      if (!id) throw Error('Missing source');
      bindings.set(key(to), id);
      afterCopy?.(from);
    },
    remove: (...path) => {
      if (key(path) === failRemove) throw Error('Interrupted move');
      bindings.delete(key(path));
    },
    provideGuest: (handle, { agentName }) => {
      creates += 1;
      bindings.set(key(handle), 'handle');
      bindings.set(key(agentName), 'state');
    },
    makeUnconfined: (worker, actualSpecifier, { powersName, resultName }) => {
      if (
        worker !== undefined ||
        actualSpecifier !== specifier ||
        bindings.get(key(powersName)) !== 'state'
      )
        throw Error('Invalid formulation');
      creates += 1;
      bindings.set(key(resultName), 'service');
    },
  };
  return {
    agent,
    bindings,
    formulas,
    creates: () => creates,
    interrupt: path => {
      failRemove = path;
    },
    afterCopy: fn => {
      afterCopy = fn;
    },
  };
};

test('fresh setup keeps all workflow objects private and retains one direct startup pin', async t => {
  const f = fixture();
  await main(f.agent);
  t.is(f.bindings.get(key([...owner, 'state'])), 'state');
  t.is(f.bindings.get(key([...owner, 'state-handle'])), 'handle');
  t.deepEqual([...f.bindings.keys()].filter(n => !n.includes('/')).sort(), [
    '@pins',
  ]);
  const before = [...f.bindings];
  await main(f.agent);
  t.deepEqual([...f.bindings], before);
  t.is(f.creates(), 2);
  t.is(f.bindings.get('@pins/workflow-service'), 'service');
});

test('legacy move preserves service and state identities without creating formulas', async t => {
  const f = fixture(true);
  await main(f.agent);
  await main(f.agent);
  t.is(f.creates(), 0);
  t.false(f.bindings.has('workflow-agent'));
  t.false(f.bindings.has('workflow-powers'));
  t.is(f.bindings.get(key([...owner, 'state'])), 'state');
  t.is(f.bindings.get(key([...owner, 'service'])), 'service');
  t.false(f.bindings.has('workflow-service'));
});

test('missing private service recovers from its pin; missing pin heals', async t => {
  const f = fixture(true);
  f.bindings.delete('workflow-service');
  await main(f.agent);
  t.is(f.bindings.get(key([...owner, 'service'])), 'service');
  t.false(f.bindings.has('workflow-service'));
  f.bindings.delete('@pins/workflow-service');
  await main(f.agent);
  t.is(f.bindings.get('@pins/workflow-service'), 'service');
  t.is(f.creates(), 0);
});

test('interrupted move resumes without losing state or growing the namespace', async t => {
  const f = fixture(true);
  f.interrupt('workflow-agent');
  await t.throwsAsync(main(f.agent), { message: /Interrupted/ });
  t.is(f.bindings.get('workflow-agent'), 'state');
  t.is(f.bindings.get(key([...owner, 'state'])), 'state');
  f.interrupt(undefined);
  await main(f.agent);
  const size = f.bindings.size;
  await main(f.agent);
  t.is(f.bindings.size, size);
  t.is(f.creates(), 0);
});

test('pin conflicts and mismatched dependencies refuse before moving state', async t => {
  for (const fault of ['pin', 'handle', 'powers', 'specifier']) {
    const f = fixture(true);
    if (fault === 'pin') f.bindings.set('@pins/workflow-service', 'other');
    else if (fault === 'handle')
      f.formulas.set('state', {
        type: 'guest',
        properties: { handle: ref('other') },
      });
    else
      f.formulas.set('service', {
        type: 'make-unconfined',
        properties: {
          powers: ref(fault === 'powers' ? 'other' : 'state'),
          specifier: {
            kind: 'literal',
            value: fault === 'specifier' ? 'file:///other.js' : specifier,
          },
        },
      });
    const before = [...f.bindings];
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(main(f.agent), { message: /Conflicting|dependencies/ });
    t.deepEqual([...f.bindings], before);
  }
});

test('canonical collision and invalid parent refuse before removing legacy aliases', async t => {
  const f = fixture(true);
  f.bindings.set('@pins/installations', 'state');
  await t.throwsAsync(main(f.agent), { message: /not a directory/ });
  f.agent.makeDirectory(['@pins', 'installations']);
  f.agent.makeDirectory(owner);
  f.bindings.set(key([...owner, 'state']), 'other');
  const before = [...f.bindings];
  await t.throwsAsync(main(f.agent), { message: /Conflicting/ });
  t.deepEqual([...f.bindings], before);
});

test('partial installations refuse instead of replacing state', async t => {
  for (const name of ['workflow-agent', 'workflow-powers']) {
    const f = fixture(true);
    f.bindings.delete(name);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(main(f.agent), { message: /Incomplete/ });
    t.is(f.creates(), 0);
  }
});

test('a changed source after copy is not removed', async t => {
  const f = fixture(true);
  f.afterCopy(from => {
    f.bindings.set(key(from), 'replacement');
  });
  await t.throwsAsync(main(f.agent), { message: /changed during copy/ });
  t.is(f.bindings.get('workflow-agent'), 'replacement');
});

test('interrupted service retirement retries without reminting or growing names', async t => {
  const f = fixture(true);
  f.interrupt('workflow-service');
  await t.throwsAsync(main(f.agent), { message: /Interrupted/ });
  t.is(f.bindings.get(key([...owner, 'service'])), 'service');
  t.is(f.bindings.get('@pins/workflow-service'), 'service');
  t.is(f.bindings.get('workflow-service'), 'service');
  f.interrupt(undefined);
  await main(f.agent);
  const before = [...f.bindings];
  await main(f.agent);
  t.deepEqual([...f.bindings], before);
  t.false(f.bindings.has('workflow-service'));
  t.is(f.creates(), 0);
});

test('private service collision refuses before changing any state or pin', async t => {
  const f = fixture(true);
  f.agent.makeDirectory(owner.slice(0, 2));
  f.agent.makeDirectory(owner);
  f.bindings.set(key([...owner, 'service']), 'other');
  const before = [...f.bindings];
  await t.throwsAsync(main(f.agent), { message: /Conflicting/ });
  t.deepEqual([...f.bindings], before);
});

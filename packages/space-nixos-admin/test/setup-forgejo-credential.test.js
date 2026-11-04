// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { main } from '../setup-forgejo-credential.js';

const path = '@pins/installations/nixos/forgejo-credential';
const makeAgent = ({ legacy = false, secret = false } = {}) => {
  const bindings = new Map([['@pins', {}]]);
  const cap = {};
  if (legacy) bindings.set('forgejo-credential', cap);
  const entries = [];
  const secretCap = {};
  const addSecret = () => {
    entries.push({
      petNamePaths: [['secrets', 'forgejo-password']],
      summary: { state: 'active' },
    });
    bindings.set('secrets/forgejo-password', secretCap);
  };
  if (secret) addSecret();
  /** @type {{ imports: any[], provisions: any[] }} */
  const calls = { imports: [], provisions: [] };
  bindings.set('@secrets/catalog', { list: async () => entries });
  bindings.set('@secrets/create', {
    createBase64: (...args) => {
      calls.imports.push(args);
      addSecret();
    },
  });
  const key = name => (Array.isArray(name) ? name.join('/') : name);
  const agent = {
    has: (...parts) => bindings.has(parts.join('/')),
    identify: (...parts) => bindings.get(parts.join('/')),
    lookup: name => {
      if (!bindings.has(key(name))) throw Error('Missing binding');
      return bindings.get(key(name));
    },
    provideDirectory: name => {
      if (!bindings.has(key(name))) bindings.set(key(name), {});
    },
    remove: name => bindings.delete(name),
    provideSecretBasicCredential: (name, options) => {
      calls.provisions.push(options);
      bindings.set(key(name), options.existingCredential || cap);
      return cap;
    },
  };
  return { agent, bindings, cap, entries, calls };
};
const env = {
  ENDO_FORGEJO_FLOOT_PW: 'bootstrap-canary',
  ENDO_FORGEJO_URL: 'https://git.example',
};
test('fresh install imports once, keeps private credential, and reruns without overwriting secret', async t => {
  const w = makeAgent();
  await main(w.agent, env);
  t.is(w.calls.imports.length, 1);
  t.is(w.bindings.get(path), w.cap);
  t.false(w.bindings.has('forgejo-credential'));
  await main(w.agent, { ...env, ENDO_FORGEJO_FLOOT_PW: 'stale' });
  t.is(w.calls.imports.length, 1);
  t.is(w.calls.provisions[1].existingCredential, w.cap);
});
test('migration preserves legacy capability and respects existing secret', async t => {
  const w = makeAgent({ legacy: true, secret: true });
  await main(w.agent, env);
  t.is(w.calls.provisions[0].existingCredential, w.cap);
  t.is(w.bindings.get(path), w.cap);
  t.false(w.bindings.has('forgejo-credential'));
  t.is(w.calls.imports.length, 0);
});
test('missing bootstrap password does not install an unused system', async t => {
  const w = makeAgent();
  await main(w.agent, {});
  t.is(w.calls.provisions.length, 0);
  t.false(w.bindings.has('@pins/installations'));
});
test('revoked and deleted secrets cannot be resurrected by bootstrap environment', async t => {
  const w = makeAgent();
  await main(w.agent, env);
  w.entries[0].summary.state = 'revoked';
  await t.throwsAsync(main(w.agent, env), { message: /revoked/ });
  w.entries.length = 0;
  w.bindings.delete('secrets/forgejo-password');
  await t.throwsAsync(main(w.agent, env), { message: /missing/ });
  t.is(w.calls.imports.length, 1);
});
test('invalid URL and conflicting capability bindings refuse', async t => {
  const w = makeAgent();
  await t.throwsAsync(
    main(w.agent, { ...env, ENDO_FORGEJO_URL: 'ssh://git.example' }),
    { message: /HTTP/ },
  );
  await main(w.agent, env);
  w.bindings.set('forgejo-credential', {});
  await t.throwsAsync(main(w.agent, env), { message: /Conflicting/ });
});

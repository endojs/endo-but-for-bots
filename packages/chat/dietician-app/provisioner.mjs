// provisioner.mjs — the multi-tenant primitive (kazputer makeInstance shape). A DietProvisioner mints fresh,
// fully-ISOLATED dietician instances: each person gets their OWN data store + diet spec + DietConsole, sharing
// only the host's locator (so one grunt /rpc resolves them) and the host's injected providers. newInstance
// returns the new owner + guide #cap= URLs; list()/describe() expose people only (NEVER swissnums). This is
// how "Alexa", "Dan", "a guest" each run their own dietician on one host with no code change. Runs after
// @endo/init. The heavy lifting (build a store + pipeline + console for a person) is the injected `mkInstance`
// callback, so this module stays decoupled from fs/providers.
import { E, Far } from '@endo/far';

const personSlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// mkInstance(person, dietSpec, { rootSwiss }) → { rootSwiss, root }  (builds + registers the console, shared locator)
// persist(records) / restore() → durable {person, rootSwiss, createdAt}[] (instances.json, mode 0600)
export const makeProvisioner = ({ baseUrl = 'http://127.0.0.1:8782', mkInstance, persist = async () => {}, restore = async () => [], clock = Date.now } = {}) => {
  const instances = new Map(); // person → { person, rootSwiss, createdAt }

  // rebuild persisted instances on boot so their caps are back in the locator (owner links survive restart).
  const ready = (async () => {
    for (const r of (await restore()) || []) {
      try { await mkInstance(r.person, null, { rootSwiss: r.rootSwiss }); instances.set(r.person, r); } catch { /* skip a broken record */ }
    }
  })();
  const save = () => persist([...instances.values()]);

  const create = async ({ person, dietSpec } = {}) => {
    await ready;
    const p = personSlug(person);
    if (!p) throw new Error('a person name is required');
    if (instances.has(p)) throw new Error(`an instance for "${p}" already exists`);
    const { rootSwiss, root } = await mkInstance(p, String(dietSpec || ''), {});
    let guideUrl = '';
    try { guideUrl = (await E(root).share('guide', `${p} safe-eats`)).url; } catch { /* guide is a convenience */ }
    const rec = { person: p, rootSwiss, createdAt: new Date(clock()).toISOString() };
    instances.set(p, rec);
    await save();
    return { person: p, ownerUrl: `${baseUrl}/#cap=${rootSwiss}`, guideUrl };
  };

  return Far('DietProvisioner', {
    describe: async () => { await ready; return { kind: 'provisioner', count: instances.size, people: [...instances.keys()] }; },
    list: async () => { await ready; return [...instances.values()].map(r => ({ person: r.person, createdAt: r.createdAt })); },
    // owner-minted: spin up a new isolated person.
    newInstance: create,
    // open self-serve alias (same behaviour; gate/rate-limit at the cap boundary if ever exposed publicly).
    signup: create,
    help: () => 'Dietician provisioner. newInstance({person, dietSpec}) → a fresh ISOLATED instance (own store + diet) → {ownerUrl, guideUrl}. list()/describe() show people only — never swissnums.',
  });
};

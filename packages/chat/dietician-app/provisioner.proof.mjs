// provisioner.proof.mjs — the multi-tenant provisioner: newInstance mints ISOLATED instances (own diet/store),
// returns owner+guide #cap= urls, refuses duplicates, lists people (not swissnums), persists, and rebuilds on
// boot. Runs under SES. Run: node provisioner.proof.mjs
import '@endo/init';
import { E, Far } from '@endo/far';
import { makeProvisioner } from './provisioner.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const denied = async fn => { try { await fn(); return false; } catch { return true; } };

(async () => {
  const stores = {}; // person → { spec, shares: [] } — a fake per-person store to prove isolation
  const mkInstance = async (person, dietSpec, opts = {}) => {
    stores[person] = stores[person] || { spec: '', shares: [] };
    if (dietSpec != null) stores[person].spec = dietSpec;
    const root = Far('FakeConsole', {
      share: async (kind, label) => { const swiss = '6'.repeat(32); stores[person].shares.push({ kind, label }); return { kind, label, swiss, url: `http://t/#cap=${swiss}` }; },
    });
    const rootSwiss = opts.rootSwiss || Buffer.from(person).toString('hex').padEnd(32, '0').slice(0, 32);
    return { rootSwiss, root };
  };
  let persisted = [];
  const persist = async recs => { persisted = recs; };
  const restore = async () => persisted;

  let now = 1000; const clock = () => now;
  const prov = makeProvisioner({ baseUrl: 'http://t', mkInstance, persist, restore, clock });

  const bob = await E(prov).newInstance({ person: 'Bob', dietSpec: 'BOB DIET — no shellfish' });
  ok(bob.person === 'bob' && bob.ownerUrl.includes('/#cap=') && bob.guideUrl.includes('/#cap='), 'newInstance → owner + guide #cap= urls');
  ok(stores.bob.spec === 'BOB DIET — no shellfish', 'bob got his OWN diet spec');
  ok(stores.bob.shares.length === 1 && stores.bob.shares[0].kind === 'guide', 'a guide link was minted for the new instance');

  await E(prov).newInstance({ person: 'carol', dietSpec: 'CAROL DIET — vegan' });
  ok(stores.bob.spec !== stores.carol.spec, 'bob and carol have ISOLATED stores + diets');

  ok(await denied(() => E(prov).newInstance({ person: 'bob' })), 'a duplicate person is refused');
  ok(await denied(() => E(prov).newInstance({ person: '' })), 'an empty person is refused');

  const list = await E(prov).list();
  ok(list.length === 2 && !JSON.stringify(list).includes('cap=') && !JSON.stringify(list).match(/[0-9a-f]{32}/), 'list() shows people + dates — NEVER swissnums');
  const desc = await E(prov).describe();
  ok(desc.kind === 'provisioner' && desc.count === 2 && desc.people.includes('bob') && desc.people.includes('carol'), 'describe() shows the people');
  ok(persisted.length === 2, 'instances persisted to durable storage');

  // restart: a fresh provisioner restores its instances (their caps rebuild into the locator)
  const prov2 = makeProvisioner({ baseUrl: 'http://t', mkInstance, persist, restore, clock });
  const d2 = await E(prov2).describe();
  ok(d2.count === 2 && d2.people.includes('bob') && d2.people.includes('carol'), 'restore rebuilds instances on boot (owner links survive restart)');

  console.log(`\n${fail ? '✗' : '✓'} provisioner: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

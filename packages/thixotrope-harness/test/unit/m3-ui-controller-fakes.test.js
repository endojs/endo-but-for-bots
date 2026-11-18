import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/far';
import { makeFakePowers } from './_m3-fake-powers.js';
import {
  features,
  featuresFor,
  collectFeatures,
} from '../../ui/src/features.js';

test('fake powers: list, submit, live, play, history', async t => {
  const { powers, control } = makeFakePowers({
    sessions: [{ title: 'A', turns: 40, archived: 5 }, {}],
  });
  const factory = await E(powers.operator).getFactory();
  const page = await E(factory).listSessions({});
  t.is(page.rows.length, 2);
  const session = page.rows[0].session;
  const snap = await E(session).watch();
  const sub = await E(powers.live).subscribe(session, snap.rev);
  const first = await E(sub).next();
  t.is(first.deliveries[0].event.type, 'snapshot');
  const receipt = await E(powers.composer).submit(session, 'hi', 'r1');
  t.is(receipt.state, 'started');
  const again = await E(powers.composer).submit(session, 'hi', 'r1');
  t.true(again.duplicate);
  control.play('s1');
  const batch = await E(sub).next();
  t.deepEqual(
    batch.deliveries.map(d => d.event.type),
    ['turn-start', 'phase', 'delta', 'final', 'usage', 'end'],
  );
  const h1 = await E(session).getHistoryPage();
  t.is(h1.turns.length, 32);
  t.is(h1.turns[0].state, 'completed');
  const h2 = await E(session).getHistoryPage(h1.next);
  t.is(h2.turns.length, 4);
  t.true(h2.archived);
  const a1 = await E(powers.history).page(session, h2.next);
  t.is(a1.turns.length, 5);
  t.true(a1.turns[0].sealed);
  t.is(a1.next, undefined);
  // M3's own directories export no feature; other lanes' (M4, M5) may be
  // present in the same tree (W3.8).
  const m3Dirs = ['sessions', 'conversation', 'shell', 'net', 'controller'];
  t.false(features.some(f => m3Dirs.includes(f.id.split('.')[0])));
  t.deepEqual(
    featuresFor('app.panel'),
    features.filter(f => f.slot === 'app.panel'),
  );
  t.throws(
    () =>
      collectFeatures([
        {
          dir: 'a',
          module: {
            feature: { id: 'a', slot: 'app.panel', component: () => null },
          },
        },
        {
          dir: 'a',
          module: {
            feature: { id: 'a', slot: 'app.panel', component: () => null },
          },
        },
      ]),
    { message: /duplicate/ },
  );
});

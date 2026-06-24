// import.test.mjs — the persona-DB importer must normalize the "mixed state" deterministically: a migrated
// place keeps its cached_menu and reads its verdict from the eval dir; an inline-verdict a-priori SKIP place
// gets its verdict SPLIT OUT into evaluations/ so place metadata carries no verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFsFolder } from '../fs-folder.mjs';
import { makeDietStore } from '../store.mjs';
import { importPersonaDb } from '../import-db.mjs';

test('import normalizes inline-verdict places into the clean place/verdict split', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-src-'));
  fs.mkdirSync(path.join(src, 'places'), { recursive: true });
  fs.mkdirSync(path.join(src, 'evaluations', 'alexa'), { recursive: true });
  // a migrated place (no inline verdict) + its eval twin
  fs.writeFileSync(path.join(src, 'places', 'good-grill.json'), JSON.stringify({ name: 'Good Grill', place_id: 'pid1', lat: 1, lng: 2, cached_menu: '# menu', primary_type: 'steak_house' }));
  fs.writeFileSync(path.join(src, 'evaluations', 'alexa', 'good-grill.json'), JSON.stringify({ place_id: 'pid1', name: 'Good Grill', verdict: 'VIABLE', summary: 'ok', promising_dishes: [], avoid_outright: [], kitchen_flexibility: 'flexible' }));
  // an inline-verdict a-priori SKIP place (no eval twin) — the mixed-state case
  fs.writeFileSync(path.join(src, 'places', 'hana-sushi.json'), JSON.stringify({ name: 'Hana Sushi', place_id: 'pid2', lat: 1, lng: 2, verdict: 'SKIP', summary: 'A-priori SKIP — sushi', kitchen_flexibility: 'N/A' }));
  const specP = path.join(src, 'alexa.md');
  fs.writeFileSync(specP, '# Alexa diet\nno onion/garlic');

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-dst-'));
  const store = makeDietStore(makeFsFolder(dest), { person: 'alexa' });
  const stats = await importPersonaDb({ srcDir: src, dietSpecPath: specP, store, person: 'alexa' });

  assert.equal(stats.places, 2, 'both places imported');
  assert.equal(stats.normalizedSkips, 1, 'the inline-verdict place got split out');
  assert.equal(stats.verdicts, 1, 'one eval-dir verdict imported');

  const hs = await store.getPlace('hana-sushi');
  assert.ok(!('verdict' in hs), 'place metadata carries NO verdict after the split');
  assert.equal(hs.cached_menu, null, 'a-priori skip place normalized to cached_menu:null');
  assert.equal((await store.getVerdict('hana-sushi')).verdict, 'SKIP', 'its verdict moved to evaluations/');

  assert.equal((await store.getPlace('good-grill')).cached_menu, '# menu', 'migrated place keeps its cached menu');
  assert.equal((await store.getVerdict('good-grill')).verdict, 'VIABLE');

  const c = await store.counts();
  assert.equal(c.VIABLE, 1);
  assert.equal(c.SKIP, 1);
  assert.equal(c.total, 2);
  assert.match(await store.readSpec(), /Alexa diet/, 'diet spec imported to diet.md');

  // merged view (what the guides read) overlays the verdict onto the place metadata
  const m = await store.merged('good-grill');
  assert.equal(m.verdict, 'VIABLE');
  assert.equal(m.primary_type, 'steak_house');

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

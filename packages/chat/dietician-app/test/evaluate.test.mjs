// evaluate.test.mjs — core.evaluate: cached-menu-preferred, idempotent, writes the verdict, UNKNOWN-safe,
// and uses the injected web cap only when there's no cached menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePipeline } from '../core.mjs';
import { makeMemStore } from './mem-store.mjs';
import { makeJudge } from '../providers/judge.mjs';

test('evaluate: cached-menu preferred, idempotent, writes verdict; UNKNOWN when no menu + no web', async () => {
  const store = makeMemStore({
    spec: 'NO ONION/GARLIC',
    places: {
      'cached-grill': { name: 'Cached Grill', place_id: 'p1', primary_type: 'steak_house', city: 'Oakland', cached_menu: '# Menu\nGrilled ribeye, plain rice' },
      'no-menu-spot': { name: 'No Menu Spot', place_id: 'p2', primary_type: 'restaurant', city: 'Oakland', cached_menu: null },
      'already-judged': { name: 'Done', place_id: 'p3', primary_type: 'restaurant', city: 'Oakland', cached_menu: '# m' },
    },
    evaluations: { 'already-judged': { place_id: 'p3', name: 'Done', verdict: 'SKIP' } },
  });
  let calls = 0;
  const judge = makeJudge({ complete: async () => { calls += 1; return '{"verdict":"VIABLE","cuisine":"steakhouse","summary":"ok","promising_dishes":[],"avoid_outright":[],"kitchen_flexibility":"high"}'; } });
  const pipe = makePipeline({ store, judge, person: 'alexa', web: null });

  const r = await pipe.evaluate({ city: 'oakland', limit: 10 });
  assert.ok(r.ok, r.error);
  assert.equal(r.evaluated, 2, 'two evaluated (already-judged skipped — idempotent)');
  assert.equal(calls, 1, 'model called ONLY for the cached-menu place (no web ⇒ no menu ⇒ no model call)');
  assert.equal((await store.getVerdict('cached-grill')).verdict, 'VIABLE');
  assert.equal((await store.getVerdict('no-menu-spot')).verdict, 'UNKNOWN', 'no menu + no web → UNKNOWN (safe)');
  assert.equal((await store.getVerdict('already-judged')).verdict, 'SKIP', 'pre-existing verdict untouched');
  assert.equal((await store.getVerdict('cached-grill')).evaluated_for, 'Alexa (MCAS+histamine+fructan)');

  const r2 = await pipe.evaluate({ city: 'oakland', limit: 10 });
  assert.equal(r2.evaluated, 0, 'idempotent: a second pass has nothing left to judge');
});

test('evaluate uses the injected web cap when there is no cached menu, and caches what it fetched', async () => {
  const store = makeMemStore({ places: { 'web-spot': { name: 'Web Spot', place_id: 'pw', primary_type: 'restaurant', city: 'Oakland', cached_menu: null } } });
  const web = {
    webSearch: async () => ({ ok: true, results: [{ url: 'https://x.test/menu' }] }),
    fetchUrl: async () => ({ text: '# Web Menu\nGrilled chicken, plain potato' }),
  };
  const judge = makeJudge({ complete: async ({ prompt }) => (/Web Menu/.test(prompt) ? '{"verdict":"BORDERLINE","summary":"ok"}' : '') });
  const pipe = makePipeline({ store, judge, web, person: 'alexa' });

  const r = await pipe.evaluate({ slugs: ['web-spot'], limit: 1 });
  assert.equal(r.evaluated, 1);
  assert.equal((await store.getVerdict('web-spot')).verdict, 'BORDERLINE');
  assert.match((await store.getPlace('web-spot')).cached_menu, /Web Menu/, 'fetched menu cached for reuse');
});

test('evaluate matches candidates by city SLUG, not exact display name (Copenhagen↔copenhagen)', async () => {
  const store = makeMemStore({
    places: { kods: { name: 'KöD', place_id: 'p1', primary_type: 'steak_house', city: 'Copenhagen', cached_menu: '# Menu\ngrilled steak, plain' } },
  });
  const judge = makeJudge({ complete: async () => '{"verdict":"VIABLE","summary":"ok"}' });
  const pipe = makePipeline({ store, judge, person: 'alexa' });
  // called with the SLUG 'copenhagen' for a city not in SEED_CITIES — must still find the "Copenhagen" candidate
  const r = await pipe.evaluate({ city: 'copenhagen', limit: 5 });
  assert.equal(r.evaluated, 1, 'the Copenhagen candidate is found + evaluated (was 0 before the slug fix)');
  assert.equal((await store.getVerdict('kods')).verdict, 'VIABLE');
});

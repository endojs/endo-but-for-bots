// evaluate-smoke.mjs — the "judge reproduces the dietician's verdicts" proof (dietician_bridge property),
// now in pure JS: re-judge a few of dan's already-evaluated places from their CACHED menus with the REAL Opus
// judge + the imported diet spec, and compare to the stored verdicts. COMPARISON ONLY — does NOT write.
//
//   node smoke/evaluate-smoke.mjs [instanceRoot] [N]
import os from 'node:os';
import { makeFsFolder } from '../fs-folder.mjs';
import { makeDietStore } from '../store.mjs';
import { makeJudge } from '../providers/judge.mjs';
import { makeAnthropicComplete, hasKey } from '../providers/anthropic.mjs';

const DEST = process.argv[2] || `${os.homedir()}/.local/state/dietician-app/instances/alexa`;
const N = Number(process.argv[3] || 6);

(async () => {
  const store = makeDietStore(makeFsFolder(DEST), { person: 'alexa' });
  const spec = await store.readSpec();
  console.log('judge-reproduces-verdicts smoke (real Opus, cached menus, NO ssh):');
  console.log(`  anthropic key: ${(await hasKey()) ? 'yes' : 'NO'} | diet spec: ${spec.length} bytes`);
  if (!(await hasKey())) { console.log('  (no ANTHROPIC_API_KEY — skipping live judge)'); process.exit(0); }
  if (!spec) { console.log('  (no diet.md in this instance — run the import first)'); process.exit(1); }

  const judge = makeJudge({ complete: makeAnthropicComplete() });

  // pick N places that have a cached_menu AND a stored decisive verdict, across verdict classes
  const picks = [];
  for (const slug of await store.listPlaces()) {
    if (picks.length >= N) break;
    const place = await store.getPlace(slug);
    const ev = await store.getVerdict(slug);
    if (place && place.cached_menu && place.cached_menu.length > 60 && ev && /^(VIABLE|BORDERLINE|SKIP)$/.test(ev.verdict)) picks.push({ slug, place, stored: ev.verdict });
  }
  console.log(`  re-judging ${picks.length} cached places (comparison only — not writing)...\n`);

  let agree = 0;
  const rows = [];
  for (const { place, stored } of picks) {
    const v = await judge.evaluate({ spec, person: 'alexa', place, menu: place.cached_menu });
    const match = v.verdict === stored;
    if (match) agree += 1;
    rows.push(`  ${match ? '✓' : '≠'} ${String(place.name).slice(0, 32).padEnd(32)} stored=${stored.padEnd(10)} judge=${v.verdict}`);
  }
  console.log(rows.join('\n'));
  console.log(`\n  agreement: ${agree}/${picks.length}`);
  console.log(agree >= Math.ceil(picks.length * 0.6)
    ? '\n✓ the ported judge reproduces the persona dietician\'s verdicts on cached menus (real Opus, key from ~/.env, no ssh).'
    : '\n⚠ lower agreement than hoped (VIABLE↔BORDERLINE is a known fuzzy boundary; SKIP should be reliable) — inspect above.');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

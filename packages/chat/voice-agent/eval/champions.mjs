// champions.mjs — Task 4 / roadmap §6d. A per-MODEL champion store: each model keeps its best-known
// orchestration-config (by eval-suite score) plus the LINEAGE of how it got there. A "challenge" scores
// a challenger config for that model and promotes it only on a strict win. PROPOSE-ONLY: this store is a
// proposal the operator reads — it never changes the live default orchestration or any agent's behavior.
//
//   node champions.mjs        # seed gemma's champion = baseline, run ONE challenge, update champions.json
import '@endo/init';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreConfig } from './score.mjs';
import { PRESETS, makeConfig } from './orchestration.mjs';
import { configDigest } from './tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'results', 'champions.json');
const nowIso = () => new Date().toISOString();

export const loadChampions = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { propose_only: true, note: 'Proposal store — does NOT change the live default orchestration. Operator reviews.', models: {} }; } };
const save = (c) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, `${JSON.stringify(c, null, 2)}\n`); };

/** Seed a model's champion if it has none. Scores the config so the seed carries a real score. */
export const seedChampion = async (model, archId, config) => {
  const c = loadChampions();
  if (c.models[model]) return c.models[model];
  const s = await scoreConfig(archId, config, { model, repeats: 3 });
  c.models[model] = {
    bestConfig: { archId, digest: s.digest, config },
    score: s.passRate,
    lineage: [{ at: nowIso(), event: 'seed', archId, digest: s.digest, score: s.passRate }],
  };
  save(c);
  return c.models[model];
};

/** Challenge a model's champion with a challenger config. Promote ONLY on a strict score win. */
export const challenge = async (model, archId, config) => {
  const c = loadChampions();
  const champ = c.models[model];
  if (!champ) throw new Error(`no champion for model ${model} — seed first`);
  const s = await scoreConfig(archId, config, { model, repeats: 3 });
  const digest = configDigest(config);
  const win = s.passRate > champ.score; // strict — ties keep the incumbent
  champ.lineage.push({ at: nowIso(), event: win ? 'promoted' : 'rejected', archId, digest, score: s.passRate, vsChampion: champ.score });
  if (win) { champ.bestConfig = { archId, digest, config }; champ.score = s.passRate; }
  save(c);
  return { model, challenger: { archId, digest, score: s.passRate }, championScore: champ.score, promoted: win };
};

const main = async () => {
  const model = 'gemma';
  const seeded = await seedChampion(model, 'arch-0000', PRESETS['arch-0000']);
  console.log(`seed: ${model} champion = ${seeded.bestConfig.archId} (digest ${seeded.bestConfig.digest}) score=${Math.round(seeded.score * 100)}%`);

  const r = await challenge(model, 'arch-min-ref', PRESETS['arch-min-ref']);
  console.log(`challenge: ${r.challenger.archId} (digest ${r.challenger.digest}) scored ${Math.round(r.challenger.score * 100)}% vs champion ${Math.round(r.championScore * 100)}% → ${r.promoted ? 'PROMOTED' : 'rejected (champion holds)'}`);

  // sanity: the promotion branch fires when a challenger strictly wins (proven by inverting the seed).
  const c2 = loadChampions();
  const altModel = 'gemma-altseed';
  if (!c2.models[altModel]) {
    await seedChampion(altModel, 'arch-min-ref', PRESETS['arch-min-ref']);        // seed a WEAK champion (50%)
    const up = await challenge(altModel, 'arch-0000', PRESETS['arch-0000']);       // challenge with the strong one
    console.log(`promotion-path check (${altModel}): challenger arch-0000 ${Math.round(up.challenger.score * 100)}% → ${up.promoted ? 'PROMOTED ✓' : 'rejected'}`);
  }

  const fin = loadChampions();
  console.log(`\nchampions.json: ${Object.keys(fin.models).length} model(s); gemma lineage = ${fin.models.gemma.lineage.map((l) => l.event).join(' → ')}`);
};
void makeConfig;
main();

// score.mjs — Task 3 / roadmap §6a,§6c. The INNER STEP of the orchestration search: take ONE
// orchestration-config, register it as an arch (identity = config_digest), run the eval suite under
// it, and record the scored run to the tree. Then the search/champion loops (Tasks 4, future) just
// call scoreConfig() over many configs. This file PROVES the inner step — it is NOT a full search.
//
//   node score.mjs            # score the baseline vs ONE restricted variant; write both to the tree
import '@endo/init';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runObstacle } from './harness.mjs';
import { addArch, recordRun, configDigest } from './tree.mjs';
import { makeConfig, PRESETS } from './orchestration.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OBS = path.join(HERE, 'obstacles');

/** scoreConfig(archId, config, {model, repeats, stamp}) → { archId, digest, passRate, cells } */
export const scoreConfig = async (archId, config, { model = 'default', repeats = 1, stamp } = {}) => {
  addArch({ id: archId, label: `${archId} (${config.promptVariant}/${Array.isArray(config.toolRing) ? config.toolRing.join('+') : config.toolRing})`, config, parent: archId === 'arch-0000' ? null : 'arch-0000' });
  const dirs = fs.readdirSync(OBS).filter((d) => fs.existsSync(path.join(OBS, d, 'grade.mjs'))).sort();
  const cells = [];
  for (const d of dirs) {
    const mod = await import(path.join(OBS, d, 'grade.mjs'));
    cells.push(await runObstacle(mod, { arch: archId, model, repeats, config }));
  }
  const run = recordRun({ arch: archId, model, cells, stamp: stamp ?? `${archId}-${configDigest(config)}` });
  return { archId, digest: configDigest(config), passRate: run.passRate, cells };
};

const main = async () => {
  const model = 'default';
  const baseline = await scoreConfig('arch-0000', PRESETS['arch-0000'], { model, repeats: 3 });
  const variant = await scoreConfig('arch-min-ref', PRESETS['arch-min-ref'], { model, repeats: 3 });

  const line = (s) => `  ${s.archId.padEnd(14)} digest=${s.digest}  passRate=${Math.round(s.passRate * 100)}%  (${s.cells.filter((c) => c.passed).length}/${s.cells.length} obstacles)`;
  console.log('orchestration-search inner step — score ONE config against the suite:');
  console.log(line(baseline));
  console.log(line(variant));
  for (const s of [baseline, variant]) for (const c of s.cells) if (!c.passed) {
    console.log(`    ${s.archId} ✗ ${c.obstacle}`);
    for (const ck of (c.detail && c.detail.checks) || []) if (!ck.pass) console.log(`        - ${ck.name}  [${ck.detail}]`);
  }
  const winner = baseline.passRate >= variant.passRate ? baseline : variant;
  console.log(`\nwinner on this suite: ${winner.archId} (${Math.round(winner.passRate * 100)}%). Both runs written to results/tree.json.`);
  // also drop a compact machine-readable result for the champion runner (Task 4) to consume.
  fs.writeFileSync(path.join(HERE, 'results', 'orchestration-score.json'),
    `${JSON.stringify({ at: new Date().toISOString(), model, scored: [baseline, variant].map(({ archId, digest, passRate }) => ({ archId, digest, passRate })) }, null, 2)}\n`);
};
void makeConfig; // re-exported shape; used by callers building ad-hoc configs
main();

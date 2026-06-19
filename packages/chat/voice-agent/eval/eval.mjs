// eval.mjs — the eval-suite CLI (roadmap §2, goal Task 1).
//   node eval.mjs --all [--arch <id>] [--model <m>] [--repeats N]
//   node eval.mjs --obstacle <substr> [...]
// Runs each obstacle's grade() via the harness, records a run to the tree, and prints the
// cross-run aggregate (latest per obstacle×arch×model) + a per-(arch,model) summary.
import '@endo/init'; // SES lockdown FIRST — obstacles import the real (hardened) cap model
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runObstacle } from './harness.mjs';
import { addArch, recordRun } from './tree.mjs';
import { loadAllCells, dedupeLatest, summarize, printTable } from './aggregate.mjs';
import { PRESETS } from './orchestration.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OBS = path.join(HERE, 'obstacles');
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };

const arch = String(flag('arch', 'arch-0000'));
const model = String(flag('model', 'default'));
const repeats = Number(flag('repeats', 3)) || 1;
const all = argv.includes('--all');
const only = flag('obstacle');

if (!all && !only) {
  console.log('usage: node eval.mjs --all [--arch <id>] [--model <m>] [--repeats N]  |  --obstacle <substr>');
  process.exit(0);
}

// baseline architecture = the current shipped harness shape (config_digest is its identity, D6)
addArch({ id: 'arch-0000', label: 'baseline (shipped harness)', config: { rolesAvailable: 'all', toolRing: 'full', promptVariant: 'default', maxSteps: 12, model: 'per-chat' } });
if (arch !== 'arch-0000') addArch({ id: arch, label: arch, parent: 'arch-0000' });

const obstacleDirs = fs.readdirSync(OBS).filter((d) => fs.existsSync(path.join(OBS, d, 'grade.mjs'))).sort();
const selected = (only && only !== true) ? obstacleDirs.filter((d) => d.includes(String(only))) : obstacleDirs;
if (!selected.length) { console.log('no matching obstacles in', OBS); process.exit(1); }

const config = PRESETS[arch] || null; // config-aware obstacles grade against this; others ignore it
const cells = [];
for (const d of selected) {
  const mod = await import(path.join(OBS, d, 'grade.mjs'));
  const cell = await runObstacle(mod, { arch, model, repeats, config });
  cells.push(cell);
  console.log(`${cell.passed ? '✅' : '❌'} ${cell.obstacle}  ${cell.passes}/${cell.repeats}  ${cell.wallMs}ms`);
  if (!cell.passed && cell.detail && Array.isArray(cell.detail.checks)) {
    for (const c of cell.detail.checks) if (!c.pass) console.log(`     ✗ ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
  }
}

const stamp = Date.now();
const run = recordRun({ arch, model, cells, stamp });
console.log(`\nrun ${run.id}: arch=${arch} model=${model} passRate=${Math.round(run.passRate * 100)}%  (${cells.filter((c) => c.passed).length}/${cells.length} obstacles)`);

// cross-run view: latest per obstacle×arch×model + a per-(arch,model) summary
const dd = dedupeLatest(loadAllCells());
printTable(dd);
console.log('\n— summary (arch · model → pass-rate) —');
for (const s of summarize(dd)) console.log(`  ${s.archModel.padEnd(26)} ${s.pass}/${s.total}  ${Math.round(s.passRate * 100)}%`);

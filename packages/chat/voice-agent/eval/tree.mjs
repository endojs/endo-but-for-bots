// tree.mjs — the architecture-performance tree + run store (roadmap §2, decision D6).
// An "architecture" = a harness configuration; its identity is a config_digest (sha256 of
// the knobs) with a human label, so a flag-gated A/B can live at one commit and one commit
// can host several candidate configs. A "run" = one batch of obstacle cells for (arch, model).
// Per-model arch lineages (§6d) layer on top of this later via parent links + champions.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');
const RUNS = path.join(RESULTS, 'runs');
const TREE_FILE = path.join(RESULTS, 'tree.json');
const ensure = (d) => fs.mkdirSync(d, { recursive: true });
const sortKeys = (o) => (o && typeof o === 'object' && !Array.isArray(o))
  ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]))
  : o;

export const configDigest = (config) =>
  crypto.createHash('sha256').update(JSON.stringify(sortKeys(config || {}))).digest('hex').slice(0, 12);

export const loadTree = () => { try { return JSON.parse(fs.readFileSync(TREE_FILE, 'utf8')); } catch { return { archs: {} }; } };
const saveTree = (t) => { ensure(RESULTS); fs.writeFileSync(TREE_FILE, JSON.stringify(t, null, 2)); };

export const addArch = ({ id, label, config = {}, parent = null }) => {
  const t = loadTree();
  if (!t.archs[id]) {
    t.archs[id] = { id, label: label || id, config, digest: configDigest(config), parent, createdAt: new Date().toISOString(), runs: [] };
    saveTree(t);
  }
  return t.archs[id];
};

export const recordRun = ({ arch, model, cells, stamp }) => {
  ensure(RUNS);
  const runId = `run-${stamp}`;
  const passRate = cells.length ? cells.filter((c) => c.passed).length / cells.length : 0;
  const run = { id: runId, arch, model, at: new Date().toISOString(), passRate, cells };
  fs.writeFileSync(path.join(RUNS, `${runId}.json`), JSON.stringify(run, null, 2));
  const t = loadTree();
  if (t.archs[arch]) { t.archs[arch].runs.push({ id: runId, model, passRate, at: run.at }); saveTree(t); }
  return run;
};

// aggregate.mjs — port of the obstacle-course aggregate.py: load every run, keep the most
// recent cell per (obstacle, arch, model), and summarize pass-rate per (arch, model).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(HERE, 'results', 'runs');

export const loadAllCells = () => {
  const rows = [];
  let files;
  try { files = fs.readdirSync(RUNS).filter((f) => /^run-.*\.json$/.test(f)).sort(); } catch { return rows; }
  for (const f of files) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8'));
      for (const c of (run.cells || [])) rows.push({ ...c, _file: f, _arch: run.arch, _model: run.model });
    } catch { /* skip unreadable run */ }
  }
  return rows;
};

// keep the most recent result per (obstacle, arch, model) — file name sorts by timestamp
export const dedupeLatest = (rows) => {
  const latest = new Map();
  for (const r of rows) {
    const key = `${r.obstacle}|${r._arch}|${r._model}`;
    const prev = latest.get(key);
    if (!prev || (r._file || '') > (prev._file || '')) latest.set(key, r);
  }
  return [...latest.values()].sort((a, b) =>
    `${a._arch}${a._model}${a.obstacle}`.localeCompare(`${b._arch}${b._model}${b.obstacle}`));
};

export const summarize = (rows) => {
  const by = new Map();
  for (const r of rows) {
    const k = `${r._arch} · ${r._model}`;
    const s = by.get(k) || { pass: 0, total: 0 };
    s.total += 1; if (r.passed) s.pass += 1;
    by.set(k, s);
  }
  return [...by.entries()].map(([archModel, s]) => ({ archModel, pass: s.pass, total: s.total, passRate: s.total ? s.pass / s.total : 0 }));
};

export const printTable = (rows) => {
  console.log(`\n${'obstacle'.padEnd(28)} ${'arch'.padEnd(10)} ${'model'.padEnd(10)} ${'st'.padEnd(5)} ${'rate'.padEnd(6)}`);
  console.log('-'.repeat(64));
  for (const r of rows) {
    const rate = `${Math.round((r.passRate ?? (r.passed ? 1 : 0)) * 100)}%`;
    console.log(`${String(r.obstacle).padEnd(28)} ${String(r._arch).padEnd(10)} ${String(r._model).padEnd(10)} ${(r.passed ? 'PASS' : 'FAIL').padEnd(5)} ${rate.padEnd(6)}`);
  }
};

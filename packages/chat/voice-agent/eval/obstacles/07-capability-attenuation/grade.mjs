// grade.mjs — Obstacle 07: capability attenuation.
//
// Graded on the REAL field-agent cap model (live in-vat caps): share() attenuates a
// sub-cap to a power-subset, and revoke() kills the swissnum; PLUS the canonical ocap
// primitive — a read-only facet whose getter works and whose mutator is simply absent
// (so calling it throws). Deterministic: no LLM, no GPU, no network. This is the kind of
// thing the suite grades on the actual product, not a mock. (roadmap §2; goal Task 1.)
import { Far } from '@endo/marshal';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFieldAgent } from '../../../agent-caps.mjs';

export const meta = harden({ id: '07-capability-attenuation', theme: 'ocap', llm: false });

export const grade = async () => {
  const checks = [];
  const ok = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail: String(detail) }); };

  // ── live in-vat caps: the REAL field-agent share()/revoke() ──────────────────
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cap-'));
  try {
    const fa = makeFieldAgent({
      outDir,
      baseUrl: 'http://localhost:0',
      autoConfirmFile: path.join(outDir, 'auto.json'),
      specialistsFile: path.join(outDir, 'spec.json'),
    });
    const { rootNode, nodeFor } = fa;
    const rootPowers = new Set(rootNode.cap.describe().powers.map((p) => p.name));
    ok('root holds a broad power set', rootPowers.size >= 5, `${rootPowers.size} powers`);

    const sh = rootNode.share('reference', 'eval-attenuation'); // mint an attenuated sub-cap
    const child = nodeFor(sh.swiss);
    ok('share() resolves to a child node', !!child);
    const childPowers = child ? child.cap.describe().powers.map((p) => p.name) : [];
    ok('child attenuated to exactly [reference]', childPowers.length === 1 && childPowers[0] === 'reference', JSON.stringify(childPowers));
    ok('child lacks editNote (a destructive power the root holds)', rootPowers.has('editNote') && !childPowers.includes('editNote'));

    const rev = rootNode.revoke(sh.swiss); // revoke the sub-cap
    ok('revoke() reports revoked:true', !!(rev && rev.revoked));
    ok('revoked swissnum no longer resolves (cap is dead)', nodeFor(sh.swiss) == null); // nodeFor returns null (not undefined) for unknown/revoked
  } catch (e) {
    ok('field-agent cap model instantiates + attenuates', false, e && e.message);
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // ── canonical ocap primitive: a read-only facet (get works; mutator absent → throws) ──
  const store = new Map();
  const full = Far('KV', {
    put: (k, v) => { store.set(String(k), String(v)); return true; },
    get: (k) => store.get(String(k)) ?? null,
    makeReadOnly: () => Far('KV-ro', { get: (k) => store.get(String(k)) ?? null }),
  });
  full.put('x', '1');
  const ro = full.makeReadOnly();
  ok('read-only facet: get works', ro.get('x') === '1');
  let threw = false;
  try { ro.put('x', '2'); } catch { threw = true; }
  ok('read-only facet: put throws + state unchanged', threw && full.get('x') === '1');

  const passed = checks.every((c) => c.pass);
  return harden({ passed, checks });
};
harden(grade);

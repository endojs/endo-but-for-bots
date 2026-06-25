// blossom.mjs — the EAGER "blossom a renderer-island per object interface" loop.
//
// When an object is SPOTTED, key it by its INTERFACE SIGNATURE (its sorted method-set — two objects with
// the same methods get the same renderer). On first sight of a NEW signature, eagerly author a confined
// renderer FORK (a `(endowments,props)=>vnode` that represents + interacts with that interface) via an
// agent, register it by signature, and reuse it forever. The renderer is a normal fork: editable,
// reviewable (it runs the same gauntlet — it's confined, so structurally exfiltration-safe), shareable
// (distribution-trust governs end-user distribution).
//
// GUARDRAILS against runaway (the cost of "eager"): a per-signature in-flight LOCK (one interface blossoms
// once even if seen 50× concurrently), a MAX_CONCURRENT cap, and a MAX_TOTAL lifetime cap. Authoring is
// fire-and-forget; callers poll status (blossoming → ready | failed).

import crypto from 'node:crypto';
import fs from 'node:fs';

const methodNames = methods => [...new Set((methods || []).map(m => (typeof m === 'string' ? m : m && m.name)).filter(Boolean))].sort();
// sigOf — the interface signature: a stable hash of the sorted method-set. THIS is the object's "type".
export const sigOf = methods => { const ms = methodNames(methods); return ms.length ? `sig-${crypto.createHash('sha256').update(`iface:${ms.join(',')}`).digest('hex').slice(0, 16)}` : 'sig-empty'; };

// makeBlossom({ file, forks, authorRenderer, maxConcurrent, maxTotal })
//   forks          — the forks store (makeForks): a renderer is created as forks.create(...).
//   authorRenderer — async ({ sig, objectName, methods, sample }) => sourceString  (the LLM step; budget-bounded by the caller).
export const makeBlossom = ({ file, forks, authorRenderer, maxConcurrent = 2, maxTotal = 300 }) => {
  let data = { renderers: {}, count: 0 };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); data = { renderers: d.renderers || {}, count: Number(d.count) || 0 }; } catch { /* fresh */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* best-effort */ } };
  const inflight = new Set(); // per-signature lock (the de-dup that makes "eager" safe)

  const rendererFor = methods => data.renderers[sigOf(methods)] || null;
  const bySig = sig => data.renderers[String(sig || '')] || null;
  const list = () => Object.values(data.renderers);

  // ensure({ methods, objectName, sample, owner }) — eager: kick off authoring for a NEW signature; return
  // the registry entry (may be 'blossoming' — poll). Never re-fires an existing/in-flight/failed signature.
  const ensure = async ({ methods, objectName = 'object', sample, owner = 'root' }) => {
    const sig = sigOf(methods);
    if (sig === 'sig-empty') return { sig, status: 'no-interface', reason: 'object exposes no methods to key a renderer on' };
    if (data.renderers[sig]) return data.renderers[sig]; // ready | blossoming | failed — do not re-fire
    if (inflight.has(sig)) return { sig, status: 'blossoming' };
    if (inflight.size >= maxConcurrent) return { sig, status: 'queued', reason: 'too many renderers blossoming at once — try again shortly' };
    if (data.count >= maxTotal) return { sig, status: 'budget-exhausted', reason: `the renderer budget (${maxTotal}) is used up` };
    inflight.add(sig);
    data.renderers[sig] = { sig, status: 'blossoming', name: objectName, methods: methodNames(methods), at: new Date().toISOString() };
    save();
    (async () => {
      try {
        const source = await authorRenderer({ sig, objectName, methods: methodNames(methods), sample });
        if (!source || typeof source !== 'string' || !source.trim()) throw new Error('the renderer agent produced no source');
        const fk = forks.create({ source, name: `${objectName} renderer`, baseId: `blossom:${sig}`, owner });
        if (!fk.ok) throw new Error(fk.error || 'could not create the renderer fork');
        data.renderers[sig] = { ...data.renderers[sig], status: 'ready', forkId: fk.id, completedAt: new Date().toISOString() };
        data.count += 1; save();
      } catch (e) {
        data.renderers[sig] = { ...data.renderers[sig], status: 'failed', error: String((e && e.message) || e) }; save();
      } finally { inflight.delete(sig); }
    })();
    return data.renderers[sig];
  };

  // forget(sig) — drop a renderer (e.g. a failed one) so it can re-blossom; the fork itself is the owner's to keep/remove.
  const forget = sig => { if (data.renderers[String(sig)]) { delete data.renderers[String(sig)]; save(); return true; } return false; };

  return harden({ sigOf, ensure, rendererFor, bySig, list, forget, stats: () => ({ total: data.count, registered: Object.keys(data.renderers).length, blossoming: inflight.size }) });
};
harden(makeBlossom);

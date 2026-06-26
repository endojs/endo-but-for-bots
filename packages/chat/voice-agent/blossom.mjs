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
// sigOf — the interface signature: a stable hash of the leaf's KIND + its sorted method-set. THIS is the
// "type" a renderer is keyed on. `kind` lets methodLESS navigator leaves (a contact, an HA entity, an agent)
// still get distinct, shared renderers (all contacts → one renderer); inventory objects key on their methods.
export const sigOf = (methods, kind = '') => { const ms = methodNames(methods); const k = String(kind || ''); return (ms.length || k) ? `sig-${crypto.createHash('sha256').update(`iface:${k}|${ms.join(',')}`).digest('hex').slice(0, 16)}` : 'sig-empty'; };

// makeBlossom({ file, forks, authorRenderer, maxConcurrent, maxTotal })
//   forks          — the forks store (makeForks): a renderer is created as forks.create(...).
//   authorRenderer — async ({ sig, objectName, methods, sample }) => sourceString  (the LLM step; budget-bounded by the caller).
export const makeBlossom = ({ file, forks, authorRenderer, maxConcurrent = 2, maxTotal = 300 }) => {
  let data = { renderers: {}, count: 0 };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); data = { renderers: d.renderers || {}, count: Number(d.count) || 0 }; } catch { /* fresh */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* best-effort */ } };
  const inflight = new Set(); // per-signature lock (the de-dup that makes "eager" safe)

  const rendererFor = (methods, kind = '') => data.renderers[sigOf(methods, kind)] || null;
  const bySig = sig => data.renderers[String(sig || '')] || null;
  const list = () => Object.values(data.renderers);

  // ensure({ methods, objectName, sample, owner, author }) — kick off authoring for a NEW signature; return
  // the registry entry (may be 'blossoming' — poll). Never re-fires an existing/in-flight/failed signature.
  // `author` (optional) overrides the default authorRenderer for THIS blossom — used to meter the LLM call
  // against the triggering CHAT's purse (the toll-bridge), so blossoming draws from that chat's budget.
  const ensure = async ({ methods, objectName = 'object', sample, owner = 'root', author, kind = '' }) => {
    const authorFn = author || authorRenderer;
    const sig = sigOf(methods, kind);
    if (sig === 'sig-empty') return { sig, status: 'no-interface', reason: 'object exposes no methods to key a renderer on' };
    if (data.renderers[sig]) return data.renderers[sig]; // ready | blossoming | failed — do not re-fire
    if (inflight.has(sig)) return { sig, status: 'blossoming' };
    if (inflight.size >= maxConcurrent) return { sig, status: 'queued', reason: 'too many renderers blossoming at once — try again shortly' };
    if (data.count >= maxTotal) return { sig, status: 'budget-exhausted', reason: `the renderer budget (${maxTotal}) is used up` };
    inflight.add(sig);
    data.renderers[sig] = { sig, status: 'blossoming', name: objectName, kind, methods: methodNames(methods), at: new Date().toISOString() };
    save();
    (async () => {
      try {
        const source = await authorFn({ sig, objectName, methods: methodNames(methods), sample, kind });
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

  // register({ methods, kind, source, objectName, owner }) — install a renderer whose SOURCE is provided
  // directly (NOT authored by a hidden LLM). This is how a NORMAL chat agent — visible in the trace — creates
  // or revises a custom view via the `customView` tool: it writes the (endowments,props)=>vnode itself and
  // hands it here. If a renderer already exists for the signature, EDIT the existing fork (new version,
  // lineage kept); otherwise create a fresh renderer fork. The chat IS the studio.
  const register = ({ methods, kind = '', source, objectName = 'object', owner = 'root' }) => {
    const src = String(source || '');
    if (!src.trim()) return { ok: false, error: 'no renderer source provided' };
    const sig = sigOf(methods, kind);
    if (sig === 'sig-empty') return { ok: false, error: 'no kind or methods to key a renderer on' };
    const existing = data.renderers[sig];
    if (existing && existing.forkId) { // REVISE the existing renderer fork
      const r = forks.edit(existing.forkId, src, owner, 'customView edit');
      if (!r.ok) return r;
      data.renderers[sig] = { ...existing, status: 'ready', name: objectName || existing.name, completedAt: new Date().toISOString() };
      save();
      return { ok: true, sig, forkId: existing.forkId, version: r.version };
    }
    const fk = forks.create({ source: src, name: `${objectName} renderer`, baseId: `blossom:${sig}`, owner }); // GENERATE a new renderer fork
    if (!fk.ok) return { ok: false, error: fk.error || 'could not create the renderer fork' };
    data.renderers[sig] = { sig, status: 'ready', name: objectName, kind, methods: methodNames(methods), forkId: fk.id, at: new Date().toISOString(), completedAt: new Date().toISOString() };
    data.count += 1; save();
    return { ok: true, sig, forkId: fk.id, version: 1 };
  };

  // forget(sig) — drop a renderer (e.g. a failed one) so it can re-blossom; the fork itself is the owner's to keep/remove.
  const forget = sig => { if (data.renderers[String(sig)]) { delete data.renderers[String(sig)]; save(); return true; } return false; };

  return harden({ sigOf, ensure, register, rendererFor, bySig, list, forget, stats: () => ({ total: data.count, registered: Object.keys(data.renderers).length, blossoming: inflight.size }) });
};
harden(makeBlossom);

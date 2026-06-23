// iroh-objects.mjs — the `objects` power's dialer for endo-iroh capabilities (the "Kumavis fix"): it makes a
// held endo-iroh reference CALLABLE. callObject() dials BY EndpointId over QUIC (no host:port) and runs the
// same {swissnum, method, args} exchange the HTTP /rpc seam uses; the swissnum is host-side only, never
// rendered (cap-hygiene). The CapTP-over-iroh dialer lives in ocapn-noise (next to the transport, where its
// @endo/ocapn dep resolves).
//
// LAZY by design: `@number0/iroh` is a NAPI native addon AND an optionalDependency. We import the dialer
// (which pulls the binding) ONLY when an iroh ref is actually dialed — so importing this module (and thus
// booting the whole voice-agent server) never depends on the native binding loading. If iroh is absent or
// the binding fails, callObject just returns a legible error instead of taking the server down at boot.

let _mod = null; let _loadErr = null;
const load = async () => {
  if (_mod) return _mod;
  if (_loadErr) throw _loadErr;
  try { _mod = await import('../../ocapn-noise/src/iroh-dialer.js'); return _mod; }
  catch (e) { _loadErr = e; throw e; }
};

// dialIrohObject({ address, swissnum, method, args }) → { ok:true, value } | { ok:false, error }
export const dialIrohObject = async opts => {
  let m; try { m = await load(); } catch (e) { return { ok: false, error: `iroh transport unavailable (${(e && e.message) || e})` }; }
  return m.dialIrohObject(opts);
};

// parseIrohAddress(addr) → { id, addr, key } (async because the dialer loads lazily)
export const parseIrohAddress = async addr => { const m = await load(); return m.parseIrohAddress(addr); };

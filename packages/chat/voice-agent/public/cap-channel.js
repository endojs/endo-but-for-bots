// cap-channel.js — a minimal CapTP-style object-capability channel over a postMessage
// MessagePort. One side exports a "bootstrap" capability (a plain object of async
// methods); the other gets a `remote` proxy whose method calls return promises resolved
// across the channel. The MessagePort itself IS the capability: only the holder of the
// port can talk, and the iframe reaches ONLY the bootstrap it was handed — no ambient
// access to the parent. That is the confinement the design wants: a stateless iframe app
// is a pure function of the Far object passed into it.
//
// This is a faithful SUBSET of @endo/captp: method dispatch + promise correlation + error
// propagation. It does NOT (yet) pass capabilities by reference or do promise pipelining —
// method results are structured-cloned plain data. Upgrade path: replace makeCapChannel
// with @endo/captp's makeCapTP once @endo/captp is bundled for the browser; the trace app's
// E(chat).method() call sites stay the same.
//
// Works in the browser (MessagePort: postMessage + onmessage/ev.data) and is unit-tested
// in Node against a mock port pair with the same interface.

export const makeCapChannel = (port, bootstrap = {}) => {
  let nextId = 1;
  const pending = new Map();
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = nextId; nextId += 1;
    pending.set(id, { resolve, reject });
    port.postMessage({ t: 'call', id, method, args });
  });
  // `then` is excluded so awaiting the proxy itself doesn't trigger a phantom call.
  const remote = new Proxy({}, {
    get: (_t, method) => (typeof method === 'string' && method !== 'then')
      ? (...args) => call(method, args)
      : undefined,
  });
  port.onmessage = async ev => {
    const d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.t === 'call') {
      const fn = bootstrap[d.method];
      if (typeof fn !== 'function') { port.postMessage({ t: 'return', id: d.id, error: `no such method: ${d.method}` }); return; }
      try { const result = await fn(...(d.args || [])); port.postMessage({ t: 'return', id: d.id, result }); }
      catch (e) { port.postMessage({ t: 'return', id: d.id, error: String((e && e.message) || e) }); }
    } else if (d.t === 'return') {
      const p = pending.get(d.id); if (!p) return; pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
    }
  };
  if (typeof port.start === 'function') port.start();
  return { remote };
};

// E(remote).method(...args) — a tiny eventual-send shim so call sites read like CapTP.
export const E = remote => remote;

// ── reusable iframe-widget shims (D3): embed ANY SPWA + hand it a bootstrap capability ──
// HOST: after the iframe loads, mint a fresh MessageChannel and hand the iframe ONE port +
// a `bootstrap` (the powers the widget may use). The port IS the authority — the iframe reaches
// only this bootstrap, never the parent's ambient scope. Returns { remote, dispose }.
export const makeCapHost = (iframe, bootstrap = {}, { targetOrigin = location.origin } = {}) => {
  const mc = new MessageChannel();
  const ch = makeCapChannel(mc.port1, bootstrap);
  iframe.contentWindow.postMessage({ t: '__capport' }, targetOrigin, [mc.port2]);
  return { remote: ch.remote, dispose: () => { try { mc.port1.close(); } catch { /* ignore */ } } };
};
// GUEST (inside the embedded SPWA): wait for the parent's __capport, wire the channel, and call
// handler(remote) with the granted-capability proxy. makeBootstrap(remote) optionally exposes methods
// back to the host (e.g. a refresh() callback). One-shot: stops listening after the first port.
export const serveCapBootstrap = (handler, makeBootstrap = () => ({})) => {
  const onMsg = ev => {
    if (!ev.data || ev.data.t !== '__capport' || !ev.ports || !ev.ports[0]) return;
    window.removeEventListener('message', onMsg);
    const ch = makeCapChannel(ev.ports[0], makeBootstrap());
    handler(ch.remote);
  };
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
};

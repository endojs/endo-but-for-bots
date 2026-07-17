// Rewrite the `ws:url` transport hint in every connection-hint address of an
// `endo://` locator to a public wss endpoint, preserving the Noise designator
// (the identity the handshake actually authenticates). This is the same
// designator-preserving rewrite `local-accept-invitation.mjs` carries inline,
// extracted as a standalone filter so the pure-CLI driver
// (`run-cross-host-cli.sh`) can pipe a locator minted by `endo invite` through
// it before feeding `endo accept`.
//
// Usage: node rewrite-ws-url.mjs '<locator>' [override]
/* global process */

const [locator, override = 'wss://minion.town/ocapn-daemon'] =
  process.argv.slice(2);

if (!locator) {
  console.error('usage: rewrite-ws-url.mjs <endo-locator> [wss-override]');
  process.exit(2);
}

const u = new URL(locator);
const [address, ...hints] = u.pathname
  .replace(/^\//, '')
  .split('@')
  .map(decodeURIComponent);
const rewritten = hints.map(at => {
  const a = new URL(at);
  const locParam = a.searchParams.get('loc');
  if (locParam) {
    const loc = JSON.parse(locParam);
    if (loc.hints && loc.hints['ws:url']) {
      loc.hints = { ...loc.hints, 'ws:url': override };
    }
    a.searchParams.set('loc', JSON.stringify(loc));
  }
  return a.href;
});
u.pathname = `/${[address, ...rewritten].map(encodeURIComponent).join('@')}`;
console.log(u.href);

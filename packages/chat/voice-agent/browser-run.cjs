// browser-run.cjs — a one-shot headless-browser worker the field agent's `browser`
// capability shells out to. Kept in a SEPARATE process so Playwright (which mutates
// intrinsics) never runs inside the agent's SES realm.
//   node browser-run.cjs visit <url>            → {ok,title,url,text}
//   node browser-run.cjs shot  <url> <outPath>  → {ok,savedTo,title,url}
//
// SSRF (SEC-9 companion): the advisory `ssrfOk` pre-check in agent-caps.mjs is NOT
// enough here — chromium does its OWN DNS resolution, so a rebinding host that answers
// PUBLIC to the advisory check can answer PRIVATE to chromium's dial. This worker closes
// that by using ssrf.mjs to resolve+vet the target host BEFORE launch and then PINNING
// chromium to exactly the vetted IP:
//   • Fail closed: a private / unresolvable / rebinding top-level host → we refuse to
//     launch chromium at all (never navigate), matching safeFetch's behaviour.
//   • Pin the top-level host to the single vetted IP via chromium's
//     `--host-resolver-rules=MAP <host> <vetted-ip>` — chromium can only connect the
//     target name to the address ssrf.mjs vetted, so the top-level cannot rebind. This
//     also pins same-host subresources/redirects to the vetted IP.
//   • Deny at the request layer (Playwright route interception): every request is gated —
//     literal private/loopback/LAN IPs are aborted (authoritative: no re-resolution can
//     bypass a literal), and non-http(s)/file schemes are aborted. Cross-host subresources
//     to OTHER hostnames are re-vetted (resolve → assert public) and aborted if private.
//
// COVERAGE vs RESIDUAL (be honest):
//   FULLY covered  — top-level rebind (pinned IP is authoritative); redirect/subresource to
//                    a literal private IP (route abort is authoritative); redirect/nav to a
//                    private *hostname* (route re-vet aborts before the request leaves).
//   RESIDUAL       — a cross-host subresource *hostname* that answers PUBLIC to our route
//                    re-vet then PRIVATE to chromium's own resolution (a rebind on a
//                    non-top-level host we chose to ALLOW): only the top-level host is
//                    pinned, so allowed subresource hosts are re-resolved by chromium
//                    (TOCTOU). Closing this fully needs an in-process forward proxy that
//                    pins EVERY connection (`--proxy-server` + safeFetch-style dial) — out
//                    of scope for this fix. WebRTC (data channels / STUN to arbitrary IPs)
//                    is not gated by host-resolver-rules or route interception either.
//
// Portability seams:
//   PLAYWRIGHT_CORE  — path to a playwright-core install (default: archua's @playwright/cli vendored
//                      copy; falls back to require.resolve('playwright-core') from this package).
//   FIELD_CHROMIUM   — browser binary. linux default /usr/bin/chromium; darwin default is Chrome.app
//                      ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome').
//   FIELD_CHROMIUM_LDPATH — LINUX-ONLY compat-libs shim (Arch ships nettle 4.0; chromium wants the
//                      .so.8/.6 soname → /var/lib/obsidian/oldlibs). Never applied on darwin.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PW = process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const CHROMIUM = process.env.FIELD_CHROMIUM
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');

// Load playwright-core's chromium launcher (vendored copy first, package fallback).
const loadChromium = () => {
  try { return require(PW).chromium; }
  catch (e1) {
    try { return require('playwright-core').chromium; }
    catch { throw new Error(`playwright-core unavailable: ${e1.message} (set PLAYWRIGHT_CORE or npm i playwright-core)`); }
  }
};

// Default SSRF guard, wired to real DNS (agent-caps.mjs uses the same module).
const loadGuard = async () => (await import(pathToFileURL(path.join(__dirname, 'ssrf.mjs')).href)).ssrfGuard;

// chromium's --host-resolver-rules replacement wants IPv6 bracketed. IP literals are
// not resolved by chromium so a MAP rule for them is a harmless no-op; we still emit it.
const resolverPinArg = (host, ip) => {
  if (!ip) return null;
  const rep = ip.includes(':') ? `[${ip}]` : ip;
  return `--host-resolver-rules=MAP ${host} ${rep}`;
};

/**
 * Run one headless-browser command with SSRF pinning + private-IP denial.
 * Deps are injectable for tests (a fake `guard` + a real/loopback chromium).
 *
 * @param {object} opts
 * @param {'visit'|'shot'} opts.cmd
 * @param {string} opts.url
 * @param {string} [opts.out]        — screenshot path (shot only)
 * @param {object} [opts.guard]      — an ssrf.mjs guard ({resolveVetted}); defaults to real-DNS ssrfGuard
 * @param {object} [opts.chromium]   — a playwright-core chromium launcher; defaults to the vendored one
 * @param {string} [opts.chromiumPath]
 * @param {object} [opts.launchEnv]
 * @returns {Promise<object>} the JSON result ({ok,...})
 */
async function browserRun({ cmd, url, out, guard, chromium, chromiumPath = CHROMIUM, launchEnv } = {}) {
  const g = guard || (await loadGuard());

  // Parse + scheme-gate the top-level URL.
  let target;
  try { target = new URL(String(url || '')); } catch { return { ok: false, error: 'invalid url' }; }
  if (!/^https?:$/.test(target.protocol)) return { ok: false, error: 'blocked/invalid url (non-http)' };

  // Authoritative pre-vet: resolve the top-level host and assert EVERY address is
  // public. Fail closed on private/unresolvable/rebinding — we never launch chromium.
  const vetted = await g.resolveVetted(target.hostname);
  if (!vetted.ok) return { ok: false, error: `blocked host: ${vetted.error}` };
  const pinIp = vetted.addrs && vetted.addrs[0] && vetted.addrs[0].address;

  const chr = chromium || loadChromium();
  // the LD_LIBRARY_PATH shim is a linux (Arch nettle soname) fix ONLY — on darwin it would break dyld.
  const env = launchEnv || (process.platform === 'linux'
    ? { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' }
    : process.env);

  const args = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  const pin = resolverPinArg(target.hostname, pinIp);
  if (pin) args.push(pin);

  let browser;
  try {
    browser = await chr.launch({ executablePath: chromiumPath, headless: true, args, env });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // Request-layer SSRF denial. route.abort() is authoritative — an aborted request
    // never reaches the network, so chromium cannot re-resolve around it.
    const hostVerdict = new Map(); // host → boolean (public?) cache
    await page.route('**/*', async route => {
      const req = route.request();
      let ru;
      try { ru = new URL(req.url()); } catch { return route.continue(); }
      const scheme = ru.protocol;
      if (scheme === 'data:' || scheme === 'blob:' || scheme === 'about:') return route.continue();
      if (scheme !== 'http:' && scheme !== 'https:') return route.abort('blockedbyclient');
      const host = ru.hostname;
      // Top-level host: its connection is forced to the vetted IP by --host-resolver-rules,
      // so allowing it here is safe (the pin, not this check, is authoritative for it).
      if (host === target.hostname) return route.continue();
      // Any other host (cross-host subresource or a redirect target): resolve + assert
      // public. resolveVetted handles literal IPs too (dns.lookup of a literal returns it,
      // then the private-range check runs) — so literal private/loopback IPs are aborted.
      let ok = hostVerdict.get(host);
      if (ok === undefined) {
        const v = await g.resolveVetted(host);
        ok = v.ok;
        hostVerdict.set(host, ok);
      }
      return ok ? route.continue() : route.abort('blockedbyclient');
    });

    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800); // let late JS settle
    const title = await page.title();
    if (cmd === 'shot') {
      await page.screenshot({ path: out });
      return { ok: true, savedTo: out, title, url: page.url() };
    }
    const text = (await page.evaluate(() => (document.body ? document.body.innerText : ''))).replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
    return { ok: true, title, url: page.url(), text };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
}

module.exports = { browserRun, resolverPinArg, loadGuard };

if (require.main === module) {
  (async () => {
    const [, , cmd, url, out] = process.argv;
    let result;
    try { result = await browserRun({ cmd, url, out }); }
    catch (e) { result = { ok: false, error: e && e.message ? e.message : String(e) }; }
    console.log(JSON.stringify(result));
  })();
}

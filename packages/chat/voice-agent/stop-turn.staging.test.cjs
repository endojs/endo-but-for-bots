#!/usr/bin/env node
// stop-turn.staging.test.cjs — STAGING proof of the ⏹ STOP control: interrupt a running agentic turn and
// drop straight into refining the prompt. While a turn runs, a Stop button appears; clicking it aborts the
// turn server-side (/cancel), supersedes it locally (the half-finished answer is discarded), and opens the
// inline editor on the last prompt so you can edit + retry. (Stubs /chat to hang so the turn stays "busy".)
//
// Run: node stop-turn.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const fs = require('node:fs');
const cap = fs.readFileSync(require('node:os').homedir() + '/.config/field-agent/root.swiss', 'utf8').trim();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await br.newPage();
    await page.addInitScript(() => {
      window.__cancelled = false;
      const orig = window.fetch;
      window.fetch = (u, o) => { u = String(u);
        if (u.endsWith('/chat') && o && o.method === 'POST') return new Promise(() => {}); // hang → the turn stays "busy"
        if (u.endsWith('/cancel')) { window.__cancelled = true; return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); }
        return orig(u, o);
      };
    });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(3000);

    ok(await page.evaluate(() => { const s = document.getElementById('stop'); return !!s && (s.style.display === 'none'); }), 'the Stop button exists and is hidden when idle');
    // start a turn (it hangs) → busy
    await page.fill('#text', 'go research the web for X'); await page.click('#send'); await page.waitForTimeout(900);
    ok(await page.evaluate(() => { const s = document.getElementById('stop'); return !!s && s.style.display !== 'none'; }), 'while the turn runs, the Stop button appears');
    ok(await page.evaluate(() => document.querySelectorAll('.msg.user').length === 1), 'the user prompt bubble rendered');

    // STOP
    await page.evaluate(() => { const s = document.getElementById('stop'); s && s.click(); }); await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({ cancelled: window.__cancelled, editorOpen: !!document.querySelector('.msg-edit'), editorText: (document.querySelector('.msg-edit') || {}).value, stopHidden: (document.getElementById('stop') || {}).style.display === 'none' }));
    ok(after.cancelled, 'Stop aborts the turn server-side (POST /cancel)');
    ok(after.editorOpen, 'Stop opens the inline prompt editor on the last prompt');
    ok(/research the web for X/.test(after.editorText || ''), `the editor is pre-filled with the original prompt — got: ${JSON.stringify(after.editorText)}`);
    ok(after.stopHidden, 'the Stop button hides again after stopping');
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });

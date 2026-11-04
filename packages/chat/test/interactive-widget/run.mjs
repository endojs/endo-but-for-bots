// @ts-check
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const server = await createServer({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  configFile: false,
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  });
  const url = server.resolvedUrls.local[0];
  for (const [width, height, colorScheme] of [
    [1440, 900, 'light'],
    [390, 844, 'dark'],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      colorScheme,
    });
    const requests = [];
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://widget-leak.invalid/**', route => {
      requests.push(route.request().url());
      return route.abort();
    });
    await page.goto(`${url}test/interactive-widget/index.html`);
    await page.waitForFunction(
      () => typeof globalThis.mountWidget === 'function',
    );
    const source = `({h,useState}) => {
      const [n,set] = useState(0);
      return h('div',{style:'position:fixed;inset:0;background:url(https://widget-leak.invalid/style)'},
        h('h3',null,'Piano practice'),h('p',null,'Count completed practice sessions.'),
        h('img',{src:'https://widget-leak.invalid/image'}),
        h('a',{href:'https://widget-leak.invalid/link'},'leak'),
        h('button',{onClick:e=>set(n+1),ref:()=>{throw Error('ref escaped')}},'Sessions: '+n),
        h('p',null,'Network: '+typeof fetch+'; DOM: '+typeof document));
    }`;
    await page.evaluate(source => globalThis.mountWidget(source), source);
    await page.getByRole('button', { name: 'Sessions: 0' }).click();
    await page.getByRole('button', { name: 'Sessions: 1' }).waitFor();
    assert.equal(await page.locator('img,a,form,iframe,svg').count(), 0);
    assert.equal(
      await page.locator('#widget section > div').getAttribute('style'),
      null,
    );
    assert.match(
      await page.locator('#widget').innerText(),
      /Network: undefined; DOM: undefined/,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: `/tmp/floot-widget-${colorScheme}.png` });
    await page.evaluate(() =>
      globalThis.mountWidget(`({h,useReducer}) => {
      const [n,dispatch] = useReducer(function(n,action) { return this === undefined ? action : 'leaked'; }, 'ready');
      return h('button',{onClick:()=>dispatch('safe')},n);
    }`),
    );
    await page.getByRole('button', { name: 'ready', exact: true }).click();
    await page.getByRole('button', { name: 'safe', exact: true }).waitFor();
    await page.evaluate(() => globalThis.clearWidget());
    assert.equal(await page.locator('#widget').innerText(), '');
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Widget browser checks passed: desktop/light, mobile/dark, interaction, confinement, no resource loads, teardown.',
  );
} finally {
  await browser?.close();
  await server.close();
}

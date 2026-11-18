// @ts-check
/* eslint-disable no-template-curly-in-string */
// The UI build (m3-interfaces.md 6.2, 17; W3.4): content-hashed names, the
// shell embeds GATEWAY_PROTOCOL and the names, sizes recorded and within
// the 600 KB gzip budget, the generated feature list (single and array
// exports, region views), and a duplicate feature id failing the build.
import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

import { buildUi, listUiModules } from '../../ui/build.mjs';
import { GATEWAY_PROTOCOL } from '../../resources/agent-host/impl/gateway/contract-m3.js';

const packageDir = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..',
  '..',
);
/** The ui.coldLoad budget's bundle part (m3-interfaces.md 13). */
const BUNDLE_GZIP_BUDGET = 600 * 1024;

/** @param {string} prefix */
const tempDir = prefix => {
  const base = path.join(packageDir, 'tmp');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(base, prefix));
};

/**
 * @param {string} root
 * @param {Record<string, string>} files
 */
const writeTree = (root, files) => {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};

test('the real UI builds: hashed names, shell, sizes within budget', async t => {
  const outDir = tempDir('w34b-');
  try {
    const started = Date.now();
    const summary = await buildUi({ outDir });
    const ms = Date.now() - started;
    const names = summary.files.map(file => file.name);
    t.regex(names[0], /^main-[0-9a-f]{16}\.js$/);
    t.regex(names[1], /^app-[0-9a-f]{16}\.css$/);
    t.is(names[2], 'index.html');
    t.deepEqual(fs.readdirSync(outDir).sort(), [...names].sort());
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    t.true(html.includes(`content="${GATEWAY_PROTOCOL}"`));
    t.true(html.includes(`/assets/${names[0]}`));
    t.true(html.includes(`/assets/${names[1]}`));
    t.true(html.includes('<title>Familiar</title>'));
    t.false(html.includes('%'), 'every placeholder replaced');
    t.false(/<script>|<style>|style="/u.test(html), 'nothing inline (CSP)');
    t.true(summary.gzipBytes < BUNDLE_GZIP_BUDGET);
    t.log(
      JSON.stringify({
        metric: 'ui.bundle',
        ms,
        files: summary.files,
        bytes: summary.bytes,
        gzipBytes: summary.gzipBytes,
      }),
    );
    // Same sources, same names; earlier hashed files are removed.
    fs.writeFileSync(path.join(outDir, 'main-0123456789abcdef.js'), 'old');
    const again = await buildUi({ outDir });
    t.is(again.digest, summary.digest);
    t.false(fs.existsSync(path.join(outDir, 'main-0123456789abcdef.js')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('the generated feature list: directory order, arrays, region views', async t => {
  const root = tempDir('w34f-');
  try {
    const srcDir = path.join(root, 'src');
    writeTree(srcDir, {
      'feature-list.js':
        'export const featureEntries = []; export const viewModules = {};\n',
      'main.js': [
        "import { featureEntries, viewModules } from './feature-list.js';",
        'globalThis.report = {',
        '  features: featureEntries.flatMap(({ dir, module }) =>',
        '    [].concat(module.feature).map(item => `${dir}:${item.id}:${item.slot}`)),',
        '  views: Object.keys(viewModules),',
        '};',
      ].join('\n'),
      'zeta/feature.js':
        "export const feature = { id: 'zeta', slot: 'app.panel', component: () => null };\n",
      'accounts/feature.js': [
        'export const feature = [',
        "  { id: 'accounts.panel', slot: 'app.panel', component: () => null },",
        "  { id: 'accounts.chip', slot: 'statusbar.chip', component: () => null },",
        '];',
      ].join('\n'),
      'sessions/index.js': 'export const Sidebar = () => null;\n',
      'styles/b.css': '.b { color: red; }\n',
      'styles/a.css': '.a { color: blue; }\n',
      'zeta/zeta.css': '.z { color: green; }\n',
    });
    const modules = listUiModules(srcDir);
    t.deepEqual(
      modules.styleFiles.map(file => path.relative(srcDir, file)),
      ['styles/a.css', 'styles/b.css', 'zeta/zeta.css'],
    );
    const outDir = path.join(root, 'out');
    const summary = await buildUi({ srcDir, outDir, minify: false });
    t.is(summary.features, 3);
    const js = fs.readFileSync(
      path.join(outDir, summary.files[0].name),
      'utf8',
    );
    /** @type {any} */
    const sandbox = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(js, sandbox);
    t.deepEqual(sandbox.report, {
      features: [
        'accounts:accounts.panel:app.panel',
        'accounts:accounts.chip:statusbar.chip',
        'zeta:zeta:app.panel',
      ],
      views: ['sessions'],
    });
    const css = fs.readFileSync(
      path.join(outDir, summary.files[1].name),
      'utf8',
    );
    t.true(
      css.indexOf('.a') < css.indexOf('.b') &&
        css.indexOf('.b') < css.indexOf('.z'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a duplicate feature id or an unknown slot fails the build', async t => {
  const root = tempDir('w34d-');
  try {
    const srcDir = path.join(root, 'src');
    writeTree(srcDir, {
      'feature-list.js': 'export const featureEntries = [];\n',
      'main.js': "import './feature-list.js';\n",
      'mentions/feature.js': [
        'export const feature = [',
        "  { id: 'mentions.addon', slot: 'composer.addon', component: () => null },",
        "  { id: 'mentions.addon', slot: 'message.renderer', component: () => null },",
        '];',
      ].join('\n'),
    });
    await t.throwsAsync(
      () => buildUi({ srcDir, outDir: path.join(root, 'out') }),
      {
        message: /duplicate UI feature id "mentions\.addon"/,
      },
    );
    writeTree(srcDir, {
      'mentions/feature.js':
        "export const feature = { id: 'mentions', slot: 'sidebar', component: () => null };\n",
    });
    // a fresh file name: Node caches an imported module by URL
    fs.renameSync(
      path.join(srcDir, 'mentions'),
      path.join(srcDir, 'mentions2'),
    );
    writeTree(srcDir, {
      'mentions2/feature.js':
        "export const feature = { id: 'mentions2', slot: 'sidebar', component: () => null };\n",
    });
    await t.throwsAsync(
      () => buildUi({ srcDir, outDir: path.join(root, 'out') }),
      {
        message: /unknown slot "sidebar"/,
      },
    );
    t.false(fs.existsSync(path.join(root, 'out')), 'nothing written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

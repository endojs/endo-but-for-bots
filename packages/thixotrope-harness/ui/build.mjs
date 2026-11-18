#!/usr/bin/env node
// @ts-check
/**
 * Build the chat UI (m3-interfaces.md 6.2, 17; W3.4) into the gateway's
 * asset directory `resources/agent-host/impl/gateway/assets/` (git
 * ignored): one ES module bundle (`main-<hash>.js`, SES lockdown and CapTP
 * included), one stylesheet (`app-<hash>.css`) and the shell
 * `index.html`, which embeds `GATEWAY_PROTOCOL` and the hashed names. The
 * gateway serves `/assets/<name>` immutable and the shell `no-cache`.
 *
 * Features: every `ui/src/<dir>/feature.js` (directory-name order) is
 * imported in Node and checked with `collectFeatures` first, so a duplicate
 * id or a bad slot fails the build; the bundle gets a generated module of
 * static imports in place of `ui/src/feature-list.js`, with the shell's
 * region views (`ui/src/sessions/index.js`, `ui/src/conversation/index.js`)
 * when they exist. Stylesheets: `ui/src/styles/*.css`, then every other
 * `ui/src/<dir>/*.css`, each directory in name order.
 *
 * CLI: `node ui/build.mjs [--out DIR] [--no-minify]` prints one JSON line.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import { gzipSync } from 'node:zlib';

// A build tool: esbuild is a dev dependency on purpose.
// eslint-disable-next-line import/no-extraneous-dependencies
import { build, transform } from 'esbuild';

import {
  GATEWAY_PROTOCOL,
  uiTexts,
} from '../resources/agent-host/impl/gateway/protocol.js';

const uiDir = path.dirname(url.fileURLToPath(import.meta.url));
export const defaultSrcDir = path.join(uiDir, 'src');
export const defaultOutDir = path.join(
  uiDir,
  '..',
  'resources',
  'agent-host',
  'impl',
  'gateway',
  'assets',
);
/** The view modules the shell looks for, by region. */
const VIEW_DIRS = ['sessions', 'conversation'];

/**
 * The feature files, view modules and stylesheets under `srcDir`.
 *
 * @param {string} srcDir
 */
export const listUiModules = srcDir => {
  const dirs = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const featureFiles = dirs
    .filter(dir => fs.existsSync(path.join(srcDir, dir, 'feature.js')))
    .map(dir => ({ dir, file: path.join(srcDir, dir, 'feature.js') }));
  /** @type {Record<string, string>} */
  const viewFiles = {};
  for (const dir of VIEW_DIRS) {
    const file = path.join(srcDir, dir, 'index.js');
    if (fs.existsSync(file)) viewFiles[dir] = file;
  }
  const cssOf = (/** @type {string} */ dir) =>
    fs
      .readdirSync(path.join(srcDir, dir))
      .filter(name => name.endsWith('.css'))
      .sort()
      .map(name => path.join(srcDir, dir, name));
  const styleFiles = [
    ...(dirs.includes('styles') ? cssOf('styles') : []),
    ...dirs.filter(dir => dir !== 'styles').flatMap(cssOf),
  ];
  return { featureFiles, viewFiles, styleFiles };
};

/**
 * The module that replaces `feature-list.js` in the bundle.
 *
 * @param {ReturnType<typeof listUiModules>} modules
 */
const featureListSource = ({ featureFiles, viewFiles }) => {
  const lines = [];
  featureFiles.forEach(({ file }, index) => {
    lines.push(`import * as feature${index} from ${JSON.stringify(file)};`);
  });
  for (const [dir, file] of Object.entries(viewFiles)) {
    lines.push(`import * as view_${dir} from ${JSON.stringify(file)};`);
  }
  lines.push(
    `export const featureEntries = [${featureFiles
      .map(
        ({ dir }, index) =>
          `{ dir: ${JSON.stringify(dir)}, module: feature${index} }`,
      )
      .join(', ')}];`,
  );
  lines.push(
    `export const viewModules = { ${Object.keys(viewFiles)
      .map(dir => `${dir}: view_${dir}`)
      .join(', ')} };`,
  );
  return lines.join('\n');
};

/** @param {string | Uint8Array} content */
const sha256 = content => createHash('sha256').update(content).digest('hex');

/**
 * Import every feature module in Node and check the collection (duplicate
 * ids, slots, components): the build fails as the page would.
 *
 * @param {Array<{ dir: string, file: string }>} featureFiles
 */
const checkFeatures = async featureFiles => {
  const { collectFeatures } = await import('./src/features.js');
  const entries = [];
  for (const { dir, file } of featureFiles) {
    // eslint-disable-next-line no-await-in-loop
    const module = await import(url.pathToFileURL(file).href);
    entries.push({ dir, module });
  }
  return collectFeatures(entries);
};

/**
 * @param {object} [options]
 * @param {string} [options.outDir] default the gateway's `assets/`
 * @param {boolean} [options.minify] default true
 * @param {string} [options.srcDir] default `ui/src` (tests)
 * @param {boolean} [options.write] default true; false only measures
 * @returns {Promise<{ files: Array<{ name: string, bytes: number, gzipBytes: number }>, bytes: number, gzipBytes: number, digest: string, features: number }>}
 */
export const buildUi = async ({
  outDir = defaultOutDir,
  minify = true,
  srcDir = defaultSrcDir,
  write = true,
} = {}) => {
  const modules = listUiModules(srcDir);
  const collected = await checkFeatures(modules.featureFiles);
  const featureList = path.join(srcDir, 'feature-list.js');

  /** @type {import('esbuild').Plugin} */
  const featureListPlugin = {
    name: 'thix-feature-list',
    setup(builder) {
      builder.onResolve({ filter: /feature-list\.js$/ }, args => {
        const resolved = path.resolve(args.resolveDir, args.path);
        return resolved === featureList
          ? { path: resolved, namespace: 'thix-feature-list' }
          : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: 'thix-feature-list' }, () => ({
        contents: featureListSource(modules),
        resolveDir: srcDir,
        loader: 'js',
      }));
    },
  };

  const result = await build({
    entryPoints: [path.join(srcDir, 'main.js')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify,
    legalComments: 'none',
    // The bundle lands in GW/assets/, inside the package typecheck's
    // `resources/**/*.js`: a generated file is not type-checked (M3-FIX).
    banner: { js: '// @ts-nocheck' },
    charset: 'utf8',
    outdir: outDir,
    plugins: [featureListPlugin],
    logLevel: 'silent',
  });
  const [js] = result.outputFiles.filter(file => file.path.endsWith('.js'));
  const cssSource = modules.styleFiles
    .map(file => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const css = (
    await transform(cssSource, { loader: 'css', minify, legalComments: 'none' })
  ).code;

  const jsName = `main-${sha256(js.contents).slice(0, 16)}.js`;
  const cssName = `app-${sha256(css).slice(0, 16)}.css`;
  const html = fs
    .readFileSync(path.join(uiDir, 'index.html'), 'utf8')
    .replace('%PROTOCOL%', String(GATEWAY_PROTOCOL))
    .replace('%TITLE%', uiTexts.pageTitle)
    .replace('%CSS%', cssName)
    .replace('%JS%', jsName);

  const outputs = [
    { name: jsName, content: Buffer.from(js.contents) },
    { name: cssName, content: Buffer.from(css) },
    { name: 'index.html', content: Buffer.from(html) },
  ];
  const files = outputs.map(({ name, content }) => ({
    name,
    bytes: content.length,
    gzipBytes: gzipSync(content).length,
  }));
  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const { name, content } of outputs) {
      const temp = path.join(outDir, `.${name}.tmp`);
      fs.writeFileSync(temp, content);
      fs.renameSync(temp, path.join(outDir, name));
    }
    // Earlier builds' hashed files (the shell, written last, names the new ones).
    const keep = new Set(outputs.map(({ name }) => name));
    for (const name of fs.readdirSync(outDir)) {
      if (
        !keep.has(name) &&
        /^(main|app)-[0-9a-f]{16}\.(js|css)$/u.test(name)
      ) {
        fs.rmSync(path.join(outDir, name));
      }
    }
  }
  return {
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    digest: sha256(html),
    features: collected.length,
  };
};

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);

if (isMain) {
  // Feature modules may call `harden` as they load (house style), as they
  // do in the page after `@endo/init`: lock this process down too.
  await import('@endo/init');
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const started = Date.now();
  buildUi({
    outDir: outIndex >= 0 ? path.resolve(args[outIndex + 1]) : defaultOutDir,
    minify: !args.includes('--no-minify'),
  }).then(
    summary => {
      console.log(
        JSON.stringify({
          event: 'ui-build',
          ms: Date.now() - started,
          ...summary,
        }),
      );
    },
    error => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

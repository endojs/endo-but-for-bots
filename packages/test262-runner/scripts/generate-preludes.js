import 'ses';
import fs from 'fs';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { readCodecPolyfill } from '@endo/ironhorse-prelude/codec-polyfill.js';

const resolve = (rel, abs) => fileURLToPath(new URL(rel, abs).toString());
const root = new URL('..', import.meta.url).toString();

const read = async location => fs.promises.readFile(fileURLToPath(location));
const write = async (target, content) => {
  const location = resolve(target, root);
  await fs.promises.writeFile(location, content);
};

const main = async () => {
  const nodePrelude = await makeBundle(
    read,
    pathToFileURL(
      resolve('../src/node-prelude.js', import.meta.url),
    ).toString(),
  );
  const xsPrelude = await makeBundle(
    read,
    pathToFileURL(resolve('../src/xs-prelude.js', import.meta.url)).toString(),
  );
  const ironhorsePrelude = await makeBundle(
    read,
    pathToFileURL(
      resolve('../src/ironhorse-prelude.js', import.meta.url),
    ).toString(),
  );
  await fs.promises.mkdir('prelude', { recursive: true });
  // Terminate each bundle expression explicitly before test262-harness
  // concatenates it with the test source.
  await write('prelude/node.js', `${nodePrelude}\n;\n`);
  await write('prelude/xs.js', `${xsPrelude}\n;\n`);
  // Ironhorse has no host `TextEncoder`/`TextDecoder` — node's prelude takes
  // them from `node:util` and XS's needs none. The codec section of the
  // daemon's own `polyfills.js`, shared with
  // `packages/thixotrope/scripts/bundle-ironhorse-worker.mjs` rather than
  // sliced here a second time. That module documents why everything below the
  // marker is excluded, and fails loudly if the marker is gone.
  const polyfills = readCodecPolyfill();
  await write('prelude/ironhorse.js', `${polyfills}\n${ironhorsePrelude}\n;\n`);
};

main().catch(err => {
  console.error('Error running main:', err);
  process.exitCode = 1;
});

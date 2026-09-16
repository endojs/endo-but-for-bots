import 'ses';
import fs from 'fs';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { fileURLToPath, pathToFileURL } from 'url';

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
  // them from `node:util` and XS's needs none. Prepend the codec section of
  // the daemon's own `polyfills.js`, sliced at its next section marker
  // exactly as `packages/thixotrope/scripts/bundle-ironhorse-worker.mjs`
  // slices it. The `assert` and `harden` sections below that marker are
  // deliberately excluded: the first collides with test262's `assert` and the
  // second installs `Object[Symbol.for('harden')]`, which makes SES's
  // `repairIntrinsics` refuse.
  const polyfills = (
    await read(
      pathToFileURL(
        resolve('../../../rust/endo/xsnap/src/polyfills.js', import.meta.url),
      ).toString(),
    )
  )
    .toString()
    .split('// -- assert polyfill --')[0];
  await write('prelude/ironhorse.js', `${polyfills}\n${ironhorsePrelude}\n;\n`);
};

main().catch(err => {
  console.error('Error running main:', err);
  process.exitCode = 1;
});

/* global process */
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
  // Prelude for the immutable-arraybuffer parity suite. Platform-agnostic: the
  // same bundle installs the shim and the Proxy factory global on Node and XS.
  const iabPrelude = await makeBundle(
    read,
    pathToFileURL(resolve('../src/iab-prelude.js', import.meta.url)).toString(),
  );

  await fs.promises.mkdir('prelude', { recursive: true });
  await write('prelude/node.js', nodePrelude);
  await write('prelude/xs.js', xsPrelude);
  await write('prelude/iab.js', iabPrelude);
};

main().catch(err => {
  console.error('Error running main:', err);
  process.exitCode = 1;
});

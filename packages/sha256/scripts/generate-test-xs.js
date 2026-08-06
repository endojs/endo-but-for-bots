import 'ses';
import { promises as fs } from 'fs';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { fileURLToPath } from 'url';

// `xst` resolves module specifiers as plain paths and knows nothing of
// `node_modules`, so the XS spot check cannot import `@endo/hex` — or any other
// package — directly. Bundle it into one self-contained script first, the same
// way `@endo/module-source` and `ses` prepare their own XS tests.

const read = async location => fs.readFile(fileURLToPath(location));

const main = async () => {
  await null; // safe-await-separator
  const temporaryDirectory = fileURLToPath(new URL('../tmp', import.meta.url));
  if (process.argv.includes('--clean')) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    return;
  }
  const xsPrelude = await makeBundle(
    read,
    new URL('../test/_xs.js', import.meta.url).href,
    { tags: new Set(['xs']) },
  );
  await fs.mkdir(temporaryDirectory, { recursive: true });
  await fs.writeFile(
    fileURLToPath(new URL('../tmp/test-xs.js', import.meta.url)),
    xsPrelude,
  );
};

main().catch(error => {
  console.error('Error running main:', error);
  process.exitCode = 1;
});

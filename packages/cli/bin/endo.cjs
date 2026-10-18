#!/usr/bin/env node
/* global process */
(async () => {
  // Endo loads `.ts` sources from its workspace packages, which needs
  // Node.js type stripping: on by default from 22.18 and 23.6.
  if (!process.features.typescript) {
    throw Error(
      `endo requires Node.js type stripping (^22.18.0 || >=23.6.0), but it is unavailable in Node.js ${process.version}`,
    );
  }
  const { main } = await import('../src/endo.js');
  await main(process.argv.slice(2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

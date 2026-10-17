#!/usr/bin/env node
/* global process */
(async () => {
  // amaro/strip, which loads the `.ts` sources, requires Node.js 22 or later.
  const [nodeMajor] = process.versions.node.split('.');
  if (Number(nodeMajor) < 22) {
    throw Error(
      `endo requires Node.js >=22, but this is Node.js ${process.version}`,
    );
  }
  await import('amaro/strip');
  const { main } = await import('../src/endo.js');
  await main(process.argv.slice(2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

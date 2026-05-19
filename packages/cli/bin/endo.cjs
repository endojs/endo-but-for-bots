#!/usr/bin/env node
(async () => {
  const { main } = await import('../src/endo.js');
  await main(process.argv.slice(2));
})().catch(async error => {
  const { isErrorPrinted } = await import('../src/error-trace.js');
  if (!isErrorPrinted(error)) {
    console.error(error);
  }
  process.exitCode = 1;
});

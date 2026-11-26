// This explicit lane requires the built wasm worker module; the ordinary JS
// suite does not. The module's host runs outside SES, as the shell and a
// Durable Object do, so this lane does not lock down. Tests run in a child
// process's main thread, not a worker thread, so a wasm crank meets Node's
// default stack size, as it would in the shell.
export default {
  files: ['test/ironhorse-wasm/module.js'],
  nodeArguments: ['--no-warnings=ExperimentalWarning'],
  workerThreads: false,
  timeout: '10m',
  concurrency: 1,
};

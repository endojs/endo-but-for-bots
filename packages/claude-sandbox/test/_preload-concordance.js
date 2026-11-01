// Ava 8.1 loads concordance lazily, on the first assertion that needs it.
// Node's `fs.realpathSync` consults the process-wide stat buffer for path
// components it has already cached as non-symlinks, and stops resolving if
// that buffer last described a socket.
// The socket tests stat Unix sockets concurrently, so a lazy load can resolve
// concordance to its unresolved pnpm store link, from which `lodash` cannot
// be found.
// Loading ava's own concordance loader before any test runs restores the
// eager behavior of ava 8.0.
const loaderUrl = new URL('../lib/concordance.js', import.meta.resolve('ava'));
const { default: loadConcordance } = await import(loaderUrl.href);
loadConcordance();

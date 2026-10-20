import v8 from 'node:v8';

// AVA flushes V8 coverage after every run. Bun does not implement this API,
// even when coverage collection is not enabled.
v8.takeCoverage = () => {};

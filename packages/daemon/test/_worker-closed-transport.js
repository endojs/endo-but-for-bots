// @ts-check

import { closeSync } from 'node:fs';

// Stay alive after closing CapTP pipes, including after graceful cancellation.
process.on('SIGTERM', () => {});
closeSync(3);
closeSync(4);
process.send?.('ready');
setInterval(() => {}, 1000);

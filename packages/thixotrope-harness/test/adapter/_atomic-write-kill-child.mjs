// @ts-check
// Kill child of atomic-write-kill.test.js: one `writeFileAtomic` that
// SIGKILLs this process at a named step (a real SIGKILL: nothing after it
// runs, no finally blocks).
//
//   node _atomic-write-kill-child.mjs <path> <killAt> <text> [scratch]
import '@endo/init';

import { argv, kill, pid } from 'node:process';

const { writeFileAtomic } =
  await import('../../resources/agent-host/impl/files.js');

const [path, killAt, text, scratch = '.tmp'] = argv.slice(2);
await writeFileAtomic(path, text, {
  scratch,
  trace: step => {
    if (step === killAt) kill(pid, 'SIGKILL');
  },
});
if (killAt === 'after') kill(pid, 'SIGKILL');

// scratchpad.mjs — a WRITABLE reference to an agent's own scratch folder inside
// the Obsidian graph. Each agent's scratch lives at
//   the field/agents/<spawner>/<agent>/scratch/
// (created within the folder of whatever agent spawned it). This is the one place
// the input agent may WRITE freely (drafts, notes-to-self, intermediate state) —
// distinct from the read-only graph.

import fsp from 'node:fs/promises';
import path from 'node:path';

const H = x => (typeof harden === 'function' ? harden(x) : x);
const within = (dir, rel) => {
  const full = path.resolve(dir, rel);
  if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error('path escapes scratch');
  return full;
};

// plain core (used by the CLI; no SES needed)
export const scratchWrite = async (dir, rel, content) => {
  const f = within(dir, rel);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, String(content));
  return { ok: true, path: path.relative(dir, f) };
};
export const scratchAppend = async (dir, rel, content) => {
  const f = within(dir, rel);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.appendFile(f, String(content));
  return { ok: true, path: path.relative(dir, f) };
};
export const scratchRead = async (dir, rel) => fsp.readFile(within(dir, rel), 'utf8');
export const scratchList = async dir => (await fsp.readdir(dir).catch(() => [])).filter(n => n !== 'README.md');
export const scratchRemove = async (dir, rel) => { await fsp.rm(within(dir, rel), { force: true }); return { ok: true }; };

// endo object — the writable capability handed to the agent. Far is imported
// lazily so the plain core + CLI work without SES (@endo/marshal needs lockdown).
export const makeScratchpad = async dir => {
  const { Far } = await import('@endo/marshal');
  return Far('Scratchpad', {
  help: () => H(`Writable scratch folder at ${dir}. The agent's own working space (drafts, ` +
    `notes-to-self, intermediate state). Methods: write(rel,content), append(rel,content), ` +
    `read(rel), list(), remove(rel), root().`),
  write: async (rel, content) => H(await scratchWrite(dir, rel, content)),
  append: async (rel, content) => H(await scratchAppend(dir, rel, content)),
  read: async rel => scratchRead(dir, rel),
  list: async () => H(await scratchList(dir)),
  remove: async rel => H(await scratchRemove(dir, rel)),
  root: () => dir,
  });
};

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const DIR = process.env.SCRATCH_DIR || `${process.env.HOME}/obsidian/vault/the field/agents/capture-agent/scratch`;
  const [cmd, rel, ...rest] = process.argv.slice(2);
  const content = rest.join(' ');
  const out = cmd === 'write' ? await scratchWrite(DIR, rel, content)
    : cmd === 'append' ? await scratchAppend(DIR, rel, content)
      : cmd === 'read' ? await scratchRead(DIR, rel)
        : cmd === 'list' ? await scratchList(DIR)
          : (() => { throw new Error('commands: write <rel> <content> | append | read <rel> | list'); })();
  console.log(typeof out === 'string' ? out : JSON.stringify(out));
}

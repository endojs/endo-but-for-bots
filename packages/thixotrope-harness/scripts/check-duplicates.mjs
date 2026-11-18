#!/usr/bin/env node
// @ts-check
/**
 * The duplicate ceiling (harness review theme T2; designs/process.md
 * section 6): runs the review's duplicate-block finder,
 * `designs/arch-review/tools/find-duplicates.mjs` (unchanged, literal mode,
 * windows of 8 normalised lines), over `guest`, `resources` and `ui`, and
 * exits 1 when the share of normalised lines inside a repeated block is
 * above `CEILING_PERCENT`.
 *
 * The ceiling only goes down: measured 3.22 % (865 of 26,887 lines) at
 * `802bd2767c`, ceiling 3.5 %. A change that lowers the share lowers the
 * ceiling in the same commit (keep about 0.25 points of margin).
 *
 * Usage: `corepack yarn lint:duplicates` (from the package);
 * `node scripts/check-duplicates.mjs --ceiling N` checks against N instead
 * (tests).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CEILING_PERCENT = 3.5;

const ceilingAt = process.argv.indexOf('--ceiling');
const ceiling =
  ceilingAt === -1 ? CEILING_PERCENT : Number(process.argv[ceilingAt + 1]);
if (!Number.isFinite(ceiling) || ceiling < 0) {
  console.error('check-duplicates: --ceiling takes a percentage');
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const finder = fileURLToPath(
  new URL('../designs/arch-review/tools/find-duplicates.mjs', import.meta.url),
);

const output = execFileSync(
  process.execPath,
  [finder, 'guest', 'resources', 'ui'],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const match =
  /normalised lines (\d+), lines in a duplicate block (\d+), clusters (\d+)/.exec(
    output,
  );
if (match === null) {
  console.error('check-duplicates: the finder printed no summary line');
  process.exit(2);
}
const [lines, repeated, clusters] = match.slice(1).map(Number);
const percent = (100 * repeated) / lines;
const summary = `duplicates: ${repeated} of ${lines} normalised lines (${percent.toFixed(2)} %) in ${clusters} clusters; ceiling ${ceiling} %`;
if (percent > ceiling) {
  console.error(`${summary}: over the ceiling`);
  console.error(
    `run node designs/arch-review/tools/find-duplicates.mjs guest resources ui for the clusters`,
  );
  process.exit(1);
}
console.log(summary);

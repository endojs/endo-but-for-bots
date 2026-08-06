// @ts-check
import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';
import {
  collectDeniedSegment,
  resolveDeniedSegments,
} from '../src/denied-segments.js';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const endoBin = path.join(dirname, '..', 'bin', 'endo.cjs');

// The `--deny` / `--allow` flags are the CLI surface for the daemon's
// `deniedSegments` mount creation option (per `provideMount` /
// `provideScratchMount`). Following the offline convention of the other
// command tests (paths-command, clear-command), the help surface is observed
// straight from commander's registration without touching a live daemon, and
// the option-resolution logic is exercised as a pure unit.

test('endo mount --help advertises --deny and --allow', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'mount',
    '--help',
  ]);
  t.regex(stdout, /Usage: endo mount/);
  t.regex(stdout, /--deny <segment>/, '--deny flag must be advertised');
  t.regex(stdout, /--allow/, '--allow flag must be advertised');
  t.notRegex(stdout, /--no-deny/, 'the old --no-deny spelling must be gone');
  t.regex(
    stdout,
    /replace the default restricted set/,
    'help must explain that --deny replaces the default set',
  );
});

test('endo mktmp --help advertises --deny and --allow', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'mktmp',
    '--help',
  ]);
  t.regex(stdout, /Usage: endo mktmp/);
  t.regex(stdout, /--deny <segment>/, '--deny flag must be advertised');
  t.regex(stdout, /--allow/, '--allow flag must be advertised');
  t.notRegex(stdout, /--no-deny/, 'the old --no-deny spelling must be gone');
});

test('collectDeniedSegment accumulates repeated occurrences in order', t => {
  t.deepEqual(collectDeniedSegment('.ssh', undefined), ['.ssh']);
  t.deepEqual(collectDeniedSegment('.aws', ['.ssh']), ['.ssh', '.aws']);
  t.deepEqual(
    collectDeniedSegment('.env', ['.ssh', '.aws']),
    ['.ssh', '.aws', '.env'],
    'a third occurrence appends without dropping the earlier segments',
  );
});

test('resolveDeniedSegments keeps the default set when no flag is given', t => {
  // Commander leaves both options undefined when neither flag appears; the
  // CLI must forward nothing so the daemon applies `defaultDeniedSegments`.
  t.is(resolveDeniedSegments(undefined, undefined), undefined);
});

test('resolveDeniedSegments replaces the default set with the named segments', t => {
  t.deepEqual(resolveDeniedSegments(['.ssh', '.aws'], undefined), [
    '.ssh',
    '.aws',
  ]);
});

test('resolveDeniedSegments disables denial for --allow (empty set)', t => {
  // `--allow` is the opposite of `--deny`: every segment is allowed, the
  // daemon's "denial disabled" spelling — never `undefined`, which would
  // instead restore the default set.
  t.deepEqual(resolveDeniedSegments(undefined, true), []);
});

test('resolveDeniedSegments rejects --deny combined with --allow', t => {
  t.throws(() => resolveDeniedSegments(['.ssh'], true), {
    message: '--deny and --allow cannot be used together',
  });
});

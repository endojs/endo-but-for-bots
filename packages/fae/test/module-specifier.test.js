// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { stableModuleSpecifier } from '../src/module-specifier.js';

test('factories and recursive spawners retain current-release module paths', t => {
  for (const release of ['old-release', 'next-release']) {
    for (const caller of ['agent.js', 'subagent-spawner.js']) {
      for (const target of ['driver.js', 'subagent-spawner.js']) {
        t.is(
          stableModuleSpecifier(
            target,
            `file:///var/lib/endo/releases/${release}/packages/fae/${caller}`,
          ),
          `file:///var/lib/endo/current/packages/fae/${target}`,
        );
      }
    }
  }
  t.is(
    stableModuleSpecifier(
      'driver.js',
      'file:///var/lib/endo/current/packages/fae/agent.js',
    ),
    'file:///var/lib/endo/current/packages/fae/driver.js',
  );
});

test('local and other-host installations keep their own module locations', t => {
  for (const base of [
    'file:///tmp/endo/packages/fae/agent.js',
    'file:///home/endo/releases/old/packages/fae/agent.js',
    'file:///var/lib/endo/releases-other/old/packages/fae/agent.js',
    'https://example.invalid/var/lib/endo/releases/old/packages/fae/agent.js',
  ]) {
    t.is(
      stableModuleSpecifier('driver.js', base),
      new URL('driver.js', base).href,
    );
  }
});

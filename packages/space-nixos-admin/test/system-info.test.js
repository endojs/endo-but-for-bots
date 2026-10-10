// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { make } from '../caplet.js';

test('reports NixOS identity, generation, and machine vitals', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nixos-system-info-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));

  const osRelease = join(dir, 'os-release');
  const currentSystem = join(dir, 'current-system');
  const systemProfile = join(dir, 'system-profile');
  const configurationRevision = join(dir, 'configuration-revision');
  const meminfo = join(dir, 'meminfo');
  const uptime = join(dir, 'uptime');
  await Promise.all([
    writeFile(
      osRelease,
      'ID=nixos\nNAME=NixOS\nPRETTY_NAME="NixOS 26.11 (Xantusia)"\n' +
        'VERSION_ID="26.11"\nBUILD_ID="26.11.20260901.abcdef0"\n',
    ),
    symlink('/nix/store/aaaaaaaa-nixos-system-test-host-26.11', currentSystem),
    symlink('/nix/var/nix/profiles/system-42-link', systemProfile),
    writeFile(configurationRevision, 'deadbeef\n'),
    writeFile(
      meminfo,
      'MemTotal:        1000 kB\nMemAvailable:     400 kB\n' +
        'SwapTotal:       200 kB\nSwapFree:         50 kB\n',
    ),
    writeFile(uptime, '12345.67 890.12\n'),
  ]);

  const admin = await make(undefined, undefined, {
    env: { ENDO_NIXOS_HOST: 'test-host' },
    systemPaths: {
      osRelease,
      currentSystem,
      systemProfile,
      configurationRevision,
      meminfo,
      uptime,
    },
  });

  const systemInfo = await admin.getSystemInfo();
  t.is(systemInfo.flakeHost, 'test-host');
  t.is(systemInfo.operatingSystem.isNixOS, true);
  t.is(systemInfo.operatingSystem.prettyName, 'NixOS 26.11 (Xantusia)');
  t.is(systemInfo.nixos.currentGeneration, 42);
  t.is(
    systemInfo.nixos.currentSystem,
    '/nix/store/aaaaaaaa-nixos-system-test-host-26.11',
  );
  t.is(systemInfo.nixos.configurationRevision, 'deadbeef');
  t.true(systemInfo.cpu.logicalCores > 0);

  const vitals = await admin.getVitals();
  t.is(vitals.memory?.totalBytes, 1_024_000n);
  t.is(vitals.memory?.usedBytes, 614_400n);
  t.deepEqual(vitals.swap, {
    totalBytes: 204_800n,
    usedBytes: 153_600n,
    freeBytes: 51_200n,
  });
  t.is(vitals.uptimeSeconds, 12_345.67);
  t.regex(vitals.sampledAt, /^\d{4}-\d{2}-\d{2}T/);

  const status = await admin.status();
  t.is(status.systemInfo.nixos.currentGeneration, 42);
  t.is(status.vitals.memory?.totalBytes, 1_024_000n);
  t.is(status.status, null);
  t.is(status.statusRead, 'absent');
});

test('defaults the flake output to the local hostname', async t => {
  const admin = await make(undefined, undefined, {
    env: { ENDO_NIXOS_HOST: '' },
  });
  const config = await admin.getConfig();
  const systemInfo = await admin.getSystemInfo();

  t.is(config.host, config.hostname);
  t.is(systemInfo.flakeHost, config.hostname);
});

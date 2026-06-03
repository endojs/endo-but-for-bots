// @ts-nocheck
/* global process */

/**
 * @file Smoke tests for the `endo gateway` subcommand surface.
 *
 * The tests exercise the CLI argument-parsing layer and the
 * read-only verbs (`where`, `install-systemd`) end-to-end, without
 * spawning a real gateway daemon. The lifecycle verbs (`start`,
 * `stop`, `log`) are exercised by their unit-level call sites; we
 * do not start a real daemon process from the CLI smoke tests
 * because that pulls in `@endo/init` lockdown and the gateway exo,
 * and the smoke tests should fail fast on commander wiring without
 * paying that cost.
 */

import path from 'path';
import url from 'url';
import test from 'ava';
import { execa } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const endoBin = path.join(dirname, '..', 'bin', 'endo');

const runEndo = (args, opts = {}) =>
  execa(process.execPath, [endoBin, ...args], {
    reject: false,
    env: {
      // Pin to user mode so the test doesn't try to read /var/lib.
      // Override the per-directory paths to writable temp space.
      HOME: opts.home || process.env.HOME,
      PATH: process.env.PATH,
      ...(opts.env || {}),
    },
  });

test('endo --help advertises the gateway command group', async t => {
  const { stdout, exitCode } = await runEndo(['--help']);
  t.is(exitCode, 0);
  t.regex(stdout, /Gateway Commands/u);
  t.regex(stdout, /\bgateway\b/u);
});

test('endo gateway --help lists the five operational verbs', async t => {
  const { stdout, exitCode } = await runEndo(['gateway', '--help']);
  t.is(exitCode, 0);
  t.regex(stdout, /\bstart\b/u);
  t.regex(stdout, /\brun\b/u);
  t.regex(stdout, /\bstop\b/u);
  t.regex(stdout, /\blog\b/u);
  t.regex(stdout, /\bwhere\b/u);
  t.regex(stdout, /\binstall-systemd\b/u);
});

test('endo gateway where prints the resolved user-mode paths', async t => {
  const { stdout, exitCode } = await runEndo(['gateway', 'where'], {
    env: { HOME: '/home/testuser' },
  });
  t.is(exitCode, 0);
  t.regex(stdout, /^mode: user$/mu);
  t.regex(stdout, /^state: .*endo-gateway/mu);
  t.regex(stdout, /^runtime: .*endo-gateway/mu);
  t.regex(stdout, /^log: .*endo-gateway/mu);
  t.regex(stdout, /^cache: .*endo-gateway/mu);
  t.regex(stdout, /^config: .*endo-gateway/mu);
});

test('endo gateway where --system uses Linux system paths', async t => {
  const { stdout, exitCode } = await runEndo(['gateway', 'where', '--system']);
  t.is(exitCode, 0);
  t.regex(stdout, /^mode: system$/mu);
  t.regex(stdout, /^state: \/var\/lib\/endo-gateway$/mu);
  t.regex(stdout, /^runtime: \/run\/endo-gateway$/mu);
  t.regex(stdout, /^log: \/var\/log\/endo-gateway$/mu);
  t.regex(stdout, /^cache: \/var\/cache\/endo-gateway$/mu);
  t.regex(stdout, /^config: \/etc\/endo-gateway\/config\.toml$/mu);
});

test('endo gateway where --json emits parseable JSON', async t => {
  const { stdout, exitCode } = await runEndo(['gateway', 'where', '--json']);
  t.is(exitCode, 0);
  const parsed = JSON.parse(stdout);
  t.is(typeof parsed.mode, 'string');
  t.is(typeof parsed.state, 'string');
  t.is(typeof parsed.runtime, 'string');
  t.truthy(parsed.sources);
  t.is(typeof parsed.sources.state, 'string');
});

test('endo gateway where honors ENDO_GATEWAY_STATE_DIR override', async t => {
  const { stdout, exitCode } = await runEndo(['gateway', 'where'], {
    env: { ENDO_GATEWAY_STATE_DIR: '/srv/endo/state' },
  });
  t.is(exitCode, 0);
  t.regex(stdout, /^state: \/srv\/endo\/state$/mu);
});

test('endo gateway install-systemd prints a valid-looking unit', async t => {
  const { stdout, exitCode } = await runEndo(['gateway', 'install-systemd']);
  t.is(exitCode, 0);
  t.regex(stdout, /\[Unit\]/u);
  t.regex(stdout, /Description=Endo Gateway/u);
  t.regex(stdout, /\[Service\]/u);
  t.regex(stdout, /User=endo$/mu);
  t.regex(stdout, /Group=endo$/mu);
  t.regex(stdout, /ExecStart=.*endo gateway run --system/u);
  t.regex(stdout, /\[Install\]/u);
  t.regex(stdout, /WantedBy=multi-user\.target/u);
});

test('endo gateway install-systemd honors --exec-start', async t => {
  const { stdout, exitCode } = await runEndo([
    'gateway',
    'install-systemd',
    '--exec-start',
    '/opt/endo/bin/endo gateway run --system',
  ]);
  t.is(exitCode, 0);
  t.regex(stdout, /ExecStart=\/opt\/endo\/bin\/endo gateway run --system/u);
});

test('endo gateway install-systemd includes hardening directives', async t => {
  const { stdout } = await runEndo(['gateway', 'install-systemd']);
  // The unit should land the systemd hardening shape the design
  // names in Feature 10; this catches a regression where a future
  // refactor strips them.
  t.regex(stdout, /ProtectSystem=strict/u);
  t.regex(stdout, /ProtectHome=true/u);
  t.regex(stdout, /NoNewPrivileges=true/u);
  t.regex(stdout, /RuntimeDirectory=endo-gateway/u);
  t.regex(stdout, /StateDirectory=endo-gateway/u);
});

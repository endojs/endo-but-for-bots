#!/usr/bin/env node
// field-up.mjs — foreground runner for Agent C on hosts without systemd (macOS/launchd, or by hand).
//
//   node scripts/field-up.mjs [path/to/env-file]
//
// Loads simple KEY=VALUE pairs from an env FILE into process.env (already-set variables win — the
// file supplies DEFAULTS, so launchd EnvironmentVariables / the shell can still override), then runs
// server.mjs IN-PROCESS (single pid — launchd's KeepAlive supervises the real server, no orphan).
// The env-file path comes from argv[2], else the FIELD_ENV variable, else no file is loaded.
//
// Format: one KEY=VALUE per line; blank lines and #-comments ignored; optional surrounding quotes
// stripped; no interpolation, no `export` keyword needed (a leading `export ` is tolerated).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.argv[2] || process.env.FIELD_ENV || '';

if (envFile) {
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); }
  catch (e) { console.error(`field-up: cannot read env file ${envFile}: ${e.message}`); process.exit(1); }
  let applied = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // real env wins
    process.env[key] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    applied += 1;
  }
  console.error(`field-up: loaded ${applied} vars from ${envFile}`);
}

// Run the server in-process so launchd supervises the actual service (Type=foreground).
await import(pathToFileURL(path.join(HERE, '..', 'server.mjs')).href);

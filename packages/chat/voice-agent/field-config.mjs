// field-config.mjs — the ONE seam between "personal/admin (dan-only)" and the shareable platform.
//
// dan's keystone (Packing up for Dweb): the machine runs in two modes, keyed only to whether dan's
// PERSONAL VOLUME (an encrypted USB, decrypted + mounted at FIELD_PERSONAL_ROOT) is present:
//   • platform mode  — no volume → no vault, no secrets, no personal/admin caps on disk. A clean,
//     fully multi-tenant Agent C. Safe to carry; safe to hand strangers LAN links.
//   • personal mode  — volume mounted → dan's vault + secrets + config + state load FROM the volume,
//     and dan becomes the privileged "user 0" with the personal/admin powers. Pull the drive → none
//     of it is on the box.
//
// So the seam between "personal" and "platform" is a literal filesystem boundary (the USB) + this
// config switch. On the home NUC today there is no FIELD_PERSONAL_ROOT, the legacy ~/.config/field-agent
// layout exists, so FIELD_MODE defaults to 'personal' with the SAME paths as before — zero behavior
// change until the personal data is physically separated onto a volume.
//
// Every personal coupling that used to be a hardcoded /home/dan literal is centralized here and derived
// from CONFIG_DIR / VAULT_DIR / STATE_DIR (+ the voice/dashboard state dirs). Point those at the volume
// (or set FIELD_PERSONAL_ROOT) and the whole personal family moves together. Existing per-file env
// overrides (OBSIDIAN_VAULT, SCOPED_CAPS_FILE, USERS_FILE, …) are still honored so nothing breaks.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Importable from BOTH the SES voice-agent server (harden is a global) AND plain-node tooling/tests
// (the P5 encrypted-drive scripts, the seam test) — fall back to identity when harden isn't installed.
const _harden = typeof harden === 'function' ? harden : x => x;

export const HOME = process.env.HOME || os.homedir() || '/home/dan';

// The PERSONAL ROOT: when set, dan's config/vault/state live UNDER it (the decrypted USB), laid out as
// { config/, vault/, state/, personal.json }. Absent → the legacy home-dir layout (personal mode on the NUC).
export const PERSONAL_ROOT = process.env.FIELD_PERSONAL_ROOT || '';

// resolve a personal sub-path: under PERSONAL_ROOT when set, else the legacy home-dir default.
export const personalAt = (sub, legacy) => (PERSONAL_ROOT ? path.join(PERSONAL_ROOT, sub) : legacy);

const exists = p => { try { return !!p && fs.existsSync(p); } catch { return false; } };

// MODE — personal iff the personal DATA is actually present, never merely a directory. With the bind-mount
// model the home dirs persist as EMPTY mountpoints when the volume is locked, so a bare-directory check would
// false-positive into a broken "personal but no data" state. The honest signal is the root cap file: it is
// there when the encrypted volume is mounted/bound, gone when it is locked (+ the originals scrubbed).
//   (a) a personal.json marker in a mounted PERSONAL_ROOT (the provisioner/non-bind case), OR
//   (b) root.swiss present at the resolved config dir (the home/bind case). Else platform.
// Override explicitly with FIELD_MODE=personal|platform.
const markerPersonal = () => exists(PERSONAL_ROOT && path.join(PERSONAL_ROOT, 'personal.json'));
const dataPresent = () => exists(path.join(process.env.FIELD_CONFIG_DIR || personalAt('config', `${HOME}/.config/field-agent`), 'root.swiss'));
export const FIELD_MODE = (process.env.FIELD_MODE === 'personal' || process.env.FIELD_MODE === 'platform')
  ? process.env.FIELD_MODE
  : (markerPersonal() || dataPresent() ? 'personal' : 'platform');
export const PERSONAL = FIELD_MODE === 'personal';

// ── the personal directory roots (rebased onto the volume when PERSONAL_ROOT is set) ─────────────────
export const CONFIG_DIR = process.env.FIELD_CONFIG_DIR || personalAt('config', `${HOME}/.config/field-agent`);
export const VAULT_DIR = process.env.OBSIDIAN_VAULT || personalAt('vault', `${HOME}/obsidian/vault`);
export const STATE_DIR = process.env.FIELD_STATE_DIR || personalAt('state/field-agent', `${HOME}/.local/state/field-agent`);
export const VOICE_STATE_DIR = process.env.VOICE_STATE_DIR || personalAt('state/voice-agent', `${HOME}/.local/state/voice-agent`);
export const DASH_STATE_DIR = process.env.DASH_STATE_DIR || personalAt('state/field-dashboard', `${HOME}/.local/state/field-dashboard`);

// ── identity ─────────────────────────────────────────────────────────────────────────────────────────
export const EMAIL_FROM = process.env.FIELD_EMAIL_FROM || 'bot@danfinlay.com';
// INSTANCE IDENTITY: which physical instance of Agent C this is (archua NUC, dan's mac at camp, …).
// Surfaces in the boot log + the /powers status payload so cap-holders and the operator can tell
// WHICH vat they are talking to. (Vat-affinity design is a separate doc; this is only the seam.)
export const INSTANCE_NAME = process.env.FIELD_INSTANCE || os.hostname();

// ── host env file (secret fallback: ANTHROPIC_API_KEY / OPENROUTER_API_KEY / HOMEASSISTANT …) ────────
// The systemd unit doesn't source ~/.env, so key readers fall back to this FILE. On the personal
// volume the migrated key subset lives at <root>/env (field-personal migrate writes it), so personalAt
// points there when FIELD_PERSONAL_ROOT is set. Override with HOST_ENV_FILE.
export const HOST_ENV_FILE = process.env.HOST_ENV_FILE || personalAt('env', path.join(HOME, '.env'));

// ── derived CONFIG-family files (all move together with CONFIG_DIR) ──────────────────────────────────
const cfg = f => path.join(CONFIG_DIR, f);
export const PERSONA_FILE = process.env.PERSONA_FILE || cfg('persona.txt');
export const EMAIL_CFG = process.env.EMAIL_CFG || cfg('email.json');
export const SPECIALISTS_FILE = process.env.SPECIALISTS_FILE || cfg('specialists.json');
export const AUTOCONFIRM_FILE = process.env.AUTOCONFIRM_FILE || cfg('auto-confirm.json');
export const WANDPOLICY_FILE = process.env.WANDPOLICY_FILE || cfg('wand-policy.json');
export const SCOPED_FILE = process.env.SCOPED_CAPS_FILE || cfg('scoped-caps.json');
export const OBJECTS_FILE = process.env.OBJECTS_FILE || cfg('accepted-objects.json');
export const USERS_FILE = process.env.USERS_FILE || cfg('users.json');
export const ROOT_SWISS_FILE = process.env.SEED_FILE || cfg('root.swiss');
export const KAZPUTER_STATE = process.env.KAZPUTER_STATE || personalAt('config/kazputer-phone/instances.json', `${HOME}/.config/kazputer-phone/instances.json`);
// NextCloud calendar/contacts app-password config (read-only here; written by the calendar setup).
// Not in the field-personal bind map today — on a volume it would live under config/field-calendar.
export const CALENDAR_CFG = process.env.FIELD_CALENDAR_CFG || personalAt('config/field-calendar/config.json', `${HOME}/.config/field-calendar/config.json`);

// ── derived STATE-family paths ───────────────────────────────────────────────────────────────────────
export const HOME_BASE = process.env.FIELD_HOME_BASE || path.join(STATE_DIR, 'home');
export const WORKTREE_DIR = process.env.FIELD_AGENT_WORKTREE_DIR || path.join(STATE_DIR, 'worktrees');
export const AUTO_MERGE_LEDGER = process.env.AUTO_MERGE_LEDGER || path.join(STATE_DIR, 'auto-merge-ledger.json');
export const FEED_FILE = process.env.FEED_FILE || path.join(DASH_STATE_DIR, 'feed.json');

// a compact snapshot for logging at boot (no secrets — just where the personal seam points).
export const configSummary = () => ({ instance: INSTANCE_NAME, mode: FIELD_MODE, personalRoot: PERSONAL_ROOT || '(legacy home layout)', configDir: CONFIG_DIR, vault: VAULT_DIR, stateDir: STATE_DIR });

_harden(personalAt);
_harden(configSummary);

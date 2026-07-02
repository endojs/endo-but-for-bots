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

// ── ENDPOINTS (PORT-6 seam) ────────────────────────────────────────────────────────────────────────
// The one source of truth for the network endpoints that used to be scattered as bare literals across
// ≥6 modules (server.mjs, research.mjs, meeting-scribe.mjs, gpu-inpaint.mjs, agent-caps.mjs,
// dietician-js.mjs, …). Every constant below keeps its CURRENT live default (archua LAN) and honors the
// SAME per-endpoint env var the consumer already reads, so importing it is a drop-in — plus the two host
// bases (TINIX_HOST/FRIKY_HOST) let a camp/mac instance relocate the whole GPU box with one override.
//
// MIGRATION FOLLOW-UPS (do NOT do here — those files are sibling-owned; this is only the seam):
//   • agent-caps.mjs:125   HA_URL           → import HOMEASSISTANT_URL (already env-overridable; centralize)
//   • agent-caps.mjs:398   ComfyUI /interrupt is HARDCODED with NO env override → import COMFY_URL (the PORT-6 bug)
//   • agent-caps.mjs:119   KAZPUTER_URL     → import KAZPUTER_URL
//   • agent-caps.mjs:126   VM_HOST          → import VM_HOST
//   • server.mjs:132       WHISPER (STT_URL)→ import STT_URL
//   • server.mjs:2449      AGENT_LLM        → import AGENT_LLM
//   • research.mjs:18      LLM (AGENT_LLM)  → import AGENT_LLM
//   • meeting-scribe.mjs:12 MEETING_DIARIZE_URL → import MEETING_DIARIZE_URL
//   • gpu-inpaint.mjs:11   COMFY (COMFY_URL)→ import COMFY_URL
//   • dietician-js.mjs:27  DIETICIAN_HOST   → import DIETICIAN_HOST
//
// Host bases: overriding TINIX_HOST alone moves gemma-LLM + whisper-STT + ComfyUI + the diarizer together
// (they all live on the tinix GPU box). A per-endpoint env var still wins over the derived default.
export const TINIX_HOST = process.env.TINIX_HOST || '192.168.50.226'; // the TinyBox GPU box (gemma / whisper / ComfyUI / diarizer)
export const FRIKY_HOST = process.env.FRIKY_HOST || '192.168.50.74'; // the sibling Unraid box (gitea / ntfy / kiwix / media)
const tinix = port => `http://${TINIX_HOST}:${port}`;

export const ENDPOINTS = _harden({
  // GPU-box (tinix) services — OpenAI-compatible inference + ComfyUI + the diarizer.
  AGENT_LLM: process.env.AGENT_LLM || `${tinix(8003)}/v1/chat/completions`, // local gemma (server.mjs, research.mjs)
  STT_URL: process.env.STT_URL || `${tinix(8000)}/v1/audio/transcriptions`, // whisper STT (server.mjs)
  COMFY_URL: process.env.COMFY_URL || tinix(8188), // ComfyUI base — /interrupt,/prompt,/upload,… (gpu-inpaint, agent-caps abort)
  MEETING_DIARIZE_URL: process.env.MEETING_DIARIZE_URL || `${tinix(8004)}/diarize`, // sherpa-onnx diarizer (meeting-scribe)
  // Home LAN / persona hosts.
  HOMEASSISTANT_URL: (process.env.HOMEASSISTANT_URL || 'http://192.168.50.11:8123').replace(/\/$/, ''), // HA REST (agent-caps)
  KAZPUTER_URL: process.env.KAZPUTER_URL || 'http://127.0.0.1:8779', // kazputer-phone RPC, loopback same-host (agent-caps)
  VM_HOST: process.env.VM_HOST || 'agent@10.89.0.3', // agent-code dev persona (agent-caps agentExec)
  DIETICIAN_HOST: process.env.DIETICIAN_HOST || 'agent@10.89.0.8', // dietician persona, publish step only (dietician-js)
  TINIX_HOST,
  FRIKY_HOST,
});

// Named exports too, so a consumer can `import { AGENT_LLM } from './field-config.mjs'` without the bag.
export const {
  AGENT_LLM, STT_URL, COMFY_URL, MEETING_DIARIZE_URL,
  HOMEASSISTANT_URL, KAZPUTER_URL, VM_HOST, DIETICIAN_HOST,
} = ENDPOINTS;

// ── EVENT_MODE (P6 — LAN event mode for DWeb Camp / meshcore) ─────────────────────────────────────────
// OPT-IN (env EVENT_MODE=1). OFF by default → byte-identical behavior on the archua NUC. When ON, the
// server ALSO binds this host's LAN (RFC-1918) address so same-LAN phones reach the app at a venue with no
// tailscale/internet, mints share/invite/#cap links at the LAN origin, and serves HTTPS with a self-signed
// cert (getUserMedia needs a SECURE CONTEXT and there is no `tailscale serve` HTTPS at camp). This is LAN
// ONLY — it NEVER binds 0.0.0.0 / a public interface (public-internet exposure stays an explicit per-instance
// operator choice, per the standing rule). Composes with the mac-vat / RUN-ON-MAC story via the same env.
export const EVENT_MODE = process.env.EVENT_MODE === '1';

// RFC-1918 private LAN ranges ONLY (10/8, 172.16/12, 192.168/16). Excludes loopback, link-local (169.254),
// and the CGNAT 100.64/10 block Tailscale uses — a camp LAN address is what we want, not the tailnet IP.
const isPrivateLan = ip => {
  if (typeof ip !== 'string') return false;
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
};

// the private-range IPv4 addresses actually present on THIS host (from os.networkInterfaces()). Used both to
// pick the LAN share-origin and to extend the bind list (still self-heal-filtered against present addresses).
export const lanAddresses = () => {
  try {
    return Object.values(os.networkInterfaces()).flat().filter(Boolean)
      .filter(i => (i.family === 'IPv4' || i.family === 4) && !i.internal && isPrivateLan(i.address))
      .map(i => i.address);
  } catch { return []; }
};

// the primary LAN IP for the share-origin (EVENT_LAN_IP override wins so the operator can pin it when a host
// has several private addresses — e.g. a real Wi-Fi LAN alongside podman bridges). '' when none is derivable.
export const LAN_IP = process.env.EVENT_LAN_IP || (lanAddresses()[0] || '');

// self-signed cert for the EVENT_MODE mic secure-context, under CONFIG_DIR so it moves with the personal
// volume (and lands in the mkdtemp sandbox during tests). Override the dir with EVENT_CERT_DIR.
export const EVENT_CERT_DIR = process.env.EVENT_CERT_DIR || path.join(CONFIG_DIR, 'event-tls');
export const EVENT_CERT_FILE = path.join(EVENT_CERT_DIR, 'cert.pem');
export const EVENT_KEY_FILE = path.join(EVENT_CERT_DIR, 'key.pem');

// the LAN share/invite origin in EVENT_MODE (https for the secure context). '' when not in event mode or no
// LAN IP is derivable. server.mjs prefers this over the tailnet default, but derives the actual scheme from
// whether the TLS cert really generated (falls back to http on the same LAN IP if openssl is unavailable).
export const eventOrigin = (port, scheme = 'https') => (EVENT_MODE && LAN_IP ? `${scheme}://${LAN_IP}:${port}` : '');

// a compact snapshot for logging at boot (no secrets — just where the personal seam points).
export const configSummary = () => ({ instance: INSTANCE_NAME, mode: FIELD_MODE, event: EVENT_MODE ? (LAN_IP || 'no-lan-ip') : false, personalRoot: PERSONAL_ROOT || '(legacy home layout)', configDir: CONFIG_DIR, vault: VAULT_DIR, stateDir: STATE_DIR });

_harden(personalAt);
_harden(lanAddresses);
_harden(eventOrigin);
_harden(configSummary);

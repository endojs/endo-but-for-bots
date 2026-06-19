// project-registry.mjs — the source-of-truth for field-agent "projects" in the devoker sense:
// a project is a GIT REPO that gets checked out (locally now; into a disposable @endo/sandbox
// slice later) so an agent+harness can work ITS source, push a branch/PR back, and update or take
// down its live deployment. This registry maps project id → { repo, branch, checkout, deploy, live,
// takedown }. The gitea token is NEVER stored here — it's read from the host secret at checkout
// time and injected via http.extraheader (cap-hygiene), exactly like pr-publish.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const STORE = process.env.PROJECT_REGISTRY || path.join(HOME, '.config/field-agent/projects-registry.json');
const TOKEN_FILE = process.env.GITEA_TOKEN_FILE || path.join(HOME, '.config/field-agent/secrets/gitea-token');
const PROJECTS_ROOT = path.join(HOME, '.local/state/field-agent/projects');

// Seed: the projects we already run live. checkout = where the agent gets the SOURCE (read/write).
const SEED = {
  'frankie-quest': {
    id: 'frankie-quest', title: 'FrankieQuest',
    repo: 'http://192.168.50.74:3030/agent-code/frankie-quest.git', branch: 'main',
    checkout: path.join(PROJECTS_ROOT, 'frankie-quest/repo'),
    deploy: { method: 'archua-deploy', trigger: 'push-to-main', service: 'frankie-quest' },
    live: { url: 'https://frankiequest.chu.vmkqx.com', container: 'frankie-quest_frankie-quest_1', ngrokSidecar: 'ngrok-frankie-quest' },
    // takedown = remove the live service container + its public ngrok sidecar (outward-facing → confirm-gated).
    takedown: ['podman rm -f frankie-quest_frankie-quest_1', 'podman rm -f ngrok-frankie-quest'],
  },
};

const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return null; } };
const save = r => { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, `${JSON.stringify(r, null, 2)}\n`); return r; };
const registry = () => load() || save({ ...SEED });

export const listProjects = () => Object.values(registry());
export const getProject = id => registry()[id] || null;
export const upsertProject = p => { const r = registry(); r[p.id] = { ...(r[p.id] || {}), ...p }; save(r); return r[p.id]; };

const token = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

/** Check out (clone or fast-forward) a project's repo into its checkout dir, so an agent has the
 *  source. Token via http.extraheader only — never written to .git/config. → { ok, path, head }. */
export const ensureCheckout = id => {
  const p = getProject(id);
  if (!p) return { ok: false, error: `unknown project ${id}` };
  const tok = token();
  const hdr = `http.extraheader=AUTHORIZATION: token ${tok}`;
  try {
    if (!fs.existsSync(path.join(p.checkout, '.git'))) {
      fs.mkdirSync(path.dirname(p.checkout), { recursive: true });
      git(['-c', hdr, 'clone', '--branch', p.branch || 'main', p.repo, p.checkout]);
    } else {
      git(['-C', p.checkout, '-c', hdr, 'fetch', 'origin', p.branch || 'main']);
      git(['-C', p.checkout, 'reset', '--hard', `origin/${p.branch || 'main'}`]);
    }
    const head = git(['-C', p.checkout, 'rev-parse', '--short', 'HEAD']).trim();
    const files = fs.readdirSync(p.checkout).filter(f => f !== '.git').length;
    return { ok: true, path: p.checkout, head, files };
  } catch (e) { return { ok: false, error: String(e && e.message || e).split('\n')[0] }; }
};

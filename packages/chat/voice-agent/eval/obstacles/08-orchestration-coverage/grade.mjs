// grade.mjs — Obstacle 08: orchestration-config coverage (Task 3 / §6a). Deterministic, config-AWARE.
//
// Scenario: a "look up X and cite a source" task needs the agent to hold the `reference` AND `web`
// powers, and a role capable of running it. This obstacle grades the ORCHESTRATION CONFIG itself —
// so the baseline (full tool-ring) passes and a restricted variant whose ring omits `web` fails.
// That gives the orchestration-search inner step a REAL differentiated score (not two identical 100%s).
import { ringPowers, ALL_POWERS } from '../../orchestration.mjs';

export const meta = harden({ id: '08-orchestration-coverage', theme: 'orchestration', llm: false });

export const grade = async ({ config = null } = {}) => {
  const checks = [];
  const ok = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail: String(detail) }); };

  // config-insensitive callers (plain `eval.mjs` with no config) assume the shipped full ring.
  const powers = config ? ringPowers(config) : new Set(ALL_POWERS);
  for (const p of ['reference', 'web']) ok(`tool-ring grants '${p}' (needed for a cited reference lookup)`, powers.has(p), [...powers].join(','));

  const roles = config && Array.isArray(config.rolesAvailable) ? config.rolesAvailable : 'all';
  ok('a role capable of the task is available', roles === 'all' || roles.includes('reference'), JSON.stringify(roles));

  const passed = checks.every((c) => c.pass);
  return harden({ passed, checks });
};
harden(grade);

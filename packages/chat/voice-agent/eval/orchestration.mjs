// orchestration.mjs — Task 3 / roadmap §6a,§6c. An orchestration-config is the SEARCH-SPACE
// point the self-tuning loop varies: which roles an agent may delegate to, which tool-ring (power
// subset) each agent holds, which prompt variant, and which model. Its identity is a config_digest
// (tree.mjs), so an A/B lives at one commit. This module defines the shape + a couple of presets;
// score.mjs scores ONE config against the eval suite and records it to the tree (the inner step of
// the orchestration search — NOT a full search).

// The universe of tool-ring powers a config may grant (a curated subset of the field agent's powers).
export const ALL_POWERS = harden(['reference', 'web', 'notes', 'images', 'feed', 'delegate', 'timers', 'phone']);

// Resolve a config's toolRing to a concrete Set of powers. 'full' = ALL_POWERS; an array = itself.
export const ringPowers = config => {
  const ring = config && config.toolRing;
  if (ring === 'full' || ring == null) return new Set(ALL_POWERS);
  if (Array.isArray(ring)) return new Set(ring);
  return new Set();
};

/** Normalize + validate a partial config into a full orchestration-config. */
export const makeConfig = (partial = {}) => harden({
  rolesAvailable: partial.rolesAvailable ?? 'all',     // 'all' | [roleName,...]
  toolRing: partial.toolRing ?? 'full',                // 'full' | [power,...]
  promptVariant: partial.promptVariant ?? 'default',   // label of the system-prompt variant
  maxSteps: partial.maxSteps ?? 12,
  model: partial.model ?? 'per-chat',
});

// Presets used by the inner-step demo: the shipped baseline vs a deliberately RESTRICTED variant
// whose tool-ring omits 'web' (so a reference-lookup obstacle that needs web will score lower).
export const PRESETS = harden({
  'arch-0000': makeConfig({ rolesAvailable: 'all', toolRing: 'full', promptVariant: 'default' }),
  'arch-min-ref': makeConfig({ rolesAvailable: ['orchestrator', 'reference'], toolRing: ['reference', 'notes'], promptVariant: 'terse' }),
});
harden(makeConfig);
harden(ringPowers);

// @ts-check
import { randomUUID } from 'node:crypto';
import { E } from '@endo/eventual-send';
import { passStyleOf } from '@endo/pass-style';
import {
  DEVELOPMENT_PRESET_ID,
  DEVELOPMENT_BACKENDS,
} from './development-environment.js';

const templates = harden([
  {
    id: DEVELOPMENT_PRESET_ID,
    title: 'Development environment',
    description:
      'A git workspace and isolated POSIX Shell with a persistent home for installed tools. Native storage cleanup is manual on its private admin.',
    objects: [
      { kind: 'git-workspace', petName: 'workspace' },
      { kind: 'development-environment', petName: 'shell' },
    ],
  },
  {
    id: 'chat-only',
    title: 'Chat only',
    description: 'Chat without shell internet access or additional objects.',
    objects: [],
  },
  {
    id: 'general',
    title: 'General assistant',
    description:
      'A general assistant with optional workspace and isolated shell.',
    objects: [
      { kind: 'git-workspace', petName: 'workspace' },
      { kind: 'development-environment', petName: 'shell' },
    ],
  },
  {
    id: 'rsi',
    title: 'RSI',
    description:
      'Develop Endo and endo-host in an isolated shell, open pull requests, and propose reviewed deployments.',
    objects: [
      { kind: 'git-workspace', petName: 'workspace' },
      { kind: 'development-environment', petName: 'shell' },
      {
        kind: 'rsi-forge',
        petName: 'pull-requests',
        grantName: 'rsi-pull-requests',
      },
      {
        kind: 'workflow-factory',
        petName: 'review-deploy',
        grantName: 'rsi-review-deploy',
      },
    ],
  },
  {
    id: 'new-project',
    title: 'New project',
    description:
      'Start a project with a writable, git-backed workspace ready to populate.',
    objects: [{ kind: 'git-workspace', petName: 'workspace' }],
  },
  {
    id: 'full-control',
    title: 'Full Endo control',
    description:
      'Full control of the Endo daemon via an "endo" host reference. High access — handle with care.',
    objects: [
      { kind: 'host-powers', petName: 'endo' },
      { kind: 'code-mount', petName: 'endo-src', required: false },
    ],
  },
  {
    id: 'machine-admin',
    title: 'Machine admin (NixOS)',
    description:
      "Full Endo control PLUS proposing this host's NixOS configuration changes and Endo releases through operator-approved deploy workflows. Root-equivalent machine control — handle with extreme care.",
    objects: [
      { kind: 'host-powers', petName: 'endo' },
      { kind: 'code-mount', petName: 'endo-src', required: false },
      // The raw caplet: the session is not a machine admin without it.
      { kind: 'nixos-admin', petName: 'nixos', grantName: 'nixos-admin' },
      // The deploy connections: optional, so the session still opens on a
      // host without the workflow service — its prompt then reports that
      // deployment is unavailable rather than falling back to the caplet.
      {
        kind: 'workflow-factory',
        petName: 'deploy-endo',
        grantName: 'deploy-endo-factory',
        required: false,
      },
      {
        kind: 'workflow-factory',
        petName: 'change-nixos',
        grantName: 'change-nixos-factory',
        required: false,
      },
    ],
  },
]);

export const BUILTIN_PRESETS = harden([
  ...templates.map(preset => ({
    ...preset,
    objects: preset.id === 'general' ? [] : preset.objects,
    templateId: preset.id,
    instructions: '',
    endowments: [],
    backendId: '',
    modelId: '',
    reasoningEffort: '',
    networkPolicy: preset.id === 'chat-only' ? 'off' : 'public-internet',
  })),
  {
    id: 'voice',
    templateId: 'general',
    title: 'Voice assistant',
    description:
      'Your Android assistant, with an isolated shell and internet access.',
    instructions: '',
    objects: templates[0].objects,
    endowments: [],
    networkPolicy: 'public-internet',
    backendId: 'fae-codex',
    modelId: 'gpt-5.6-sol',
    reasoningEffort: '',
  },
]);
harden(BUILTIN_PRESETS);

const protectedTemplates = harden(['chat-only', 'rsi']);
const builtinId = (config, id) => config.builtinAliases?.[id] ?? id;
const STORAGE_NAME = 'floot-preset-settings';
const defaults = harden({
  version: 2,
  revision: '0',
  voicePresetId: 'voice',
  presets: BUILTIN_PRESETS,
});

/** @param {unknown} value @param {string} label @param {number} max @param {boolean} [empty] */
const text = (value, label, max, empty = true) => {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim())
  )
    throw Error(`Invalid ${label}`);
  return value;
};
const name = value => {
  text(value, 'endowment name', 80, false);
  if (
    value.includes('@') ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    [...value].some(char => Number(char.charCodeAt(0)) < 32) ||
    [
      'user',
      'tools',
      'subagents',
      '__proto__',
      'constructor',
      'prototype',
    ].includes(value)
  )
    throw Error(`Reserved or invalid endowment name: ${value}`);
  return value;
};

/** Validate data at the factory boundary; capabilities must be explicitly supplied. */
const normalizePreset = preset => {
  if (!preset || typeof preset !== 'object') throw Error('Invalid preset');
  const id = text(preset.id, 'preset id', 80, false);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw Error('Invalid preset id');
  const template = templates.find(item => item.id === preset.templateId);
  if (!template) throw Error('Unknown preset template');
  if (
    !Array.isArray(preset.objects) ||
    Number(preset.objects.length) > 16 ||
    !Array.isArray(preset.endowments) ||
    Number(preset.endowments.length) > 32
  )
    throw Error('Invalid preset endowments');
  const names = new Set();
  const selectedObjects = preset.objects.map(object => {
    const allowed = template.objects.find(
      item => item.kind === object.kind && item.petName === object.petName,
    );
    if (!allowed || names.has(allowed.petName))
      throw Error('Invalid template object');
    names.add(allowed.petName);
    return allowed;
  });
  const objects = template.objects.filter(object =>
    selectedObjects.includes(object),
  );
  if (
    [DEVELOPMENT_PRESET_ID, 'rsi'].includes(template.id) &&
    objects.length !== template.objects.length
  )
    throw Error('This preset requires all of its template objects');
  if (
    objects.some(object => object.kind === 'development-environment') &&
    !objects.some(object => object.kind === 'git-workspace')
  )
    throw Error('An isolated shell requires a workspace');
  if (
    objects.some(object => object.kind === 'nixos-admin') &&
    !objects.some(object => object.kind === 'host-powers')
  )
    throw Error('Machine administration requires Endo host control');
  const networkPolicy = text(
    preset.networkPolicy ||
      (template.id === 'chat-only' ? 'off' : 'public-internet'),
    'network policy',
    40,
  );
  if (!['off', 'public-internet'].includes(networkPolicy))
    throw Error('Invalid network policy');
  const endowments = preset.endowments.map(item => {
    const petName = name(item.petName);
    if (names.has(petName)) throw Error(`Duplicate endowment name: ${petName}`);
    names.add(petName);
    if (
      !Object.hasOwn(item, 'value') ||
      passStyleOf(item.value) !== 'remotable'
    )
      throw Error(`Endowment ${petName} must be an object capability`);
    const sourcePath = item.sourcePath;
    if (
      !Array.isArray(sourcePath) ||
      !sourcePath.length ||
      sourcePath.length > 16
    )
      throw Error('Invalid endowment source path');
    sourcePath.forEach(part => text(part, 'source path segment', 256, false));
    return { petName, sourcePath: [...sourcePath], value: item.value };
  });
  if (
    template.id === 'chat-only' &&
    (networkPolicy !== 'off' || endowments.length)
  ) {
    throw Error('Chat only requires internet off and no additional objects');
  }
  if (template.id === 'rsi' && endowments.length) {
    throw Error('RSI permits only its reviewed template capabilities');
  }
  const backendId = text(preset.backendId ?? '', 'backend', 120);
  const modelId = text(preset.modelId ?? '', 'model', 256);
  const reasoningEffort = text(
    preset.reasoningEffort ?? '',
    'reasoning effort',
    40,
  );
  if (!backendId && (modelId || reasoningEffort))
    throw Error('Choose a backend for model defaults');
  if (backendId && backendId !== 'provider' && !modelId)
    throw Error('Choose a model for this backend');
  return harden({
    id,
    templateId: template.id,
    title: text(preset.title, 'preset title', 120, false),
    description: text(preset.description ?? '', 'description', 1000),
    instructions: text(preset.instructions ?? '', 'instructions', 32_768),
    objects,
    endowments,
    backendId,
    modelId,
    reasoningEffort,
    networkPolicy,
  });
};

/** The session's retained authority recipe, independent of later catalog edits. */
export const sessionPreset = entry => {
  if (entry?.presetSnapshot) return entry.presetSnapshot;
  const preset = BUILTIN_PRESETS.find(
    item => item.id === (entry?.presetId || 'general'),
  );
  if (!preset || protectedTemplates.includes(preset.id))
    throw Error('Session has no retained preset snapshot');
  // Snapshotless sessions predate configurable defaults. Their descendants
  // inherit the old grants and the live parent's actual environment policy.
  return harden({
    ...preset,
    networkPolicy: preset.id === 'voice' ? 'public-internet' : '',
  });
};
harden(sessionPreset);
export const presetHasShell = preset =>
  preset.objects.some(object => object.kind === 'development-environment');
harden(presetHasShell);

/**
 * Capture the actual plan for a fresh session. An internet-enabled session
 * gets a policy-controlled shell. Without an explicit git workspace its
 * shell uses a private scratch mount; it gains no publishing capability.
 * @param {any} preset
 * @param {string} policy
 */
export const withSessionNetwork = (preset, policy) => {
  if (!['off', 'public-internet'].includes(policy))
    throw Error('Invalid network policy');
  if (policy === 'public-internet' && preset.templateId === 'chat-only')
    throw Error('Chat only requires internet off');
  let objects = preset.objects;
  if (policy === 'public-internet' && !presetHasShell(preset)) {
    if (preset.endowments.some(item => item.petName === 'shell')) {
      throw Error(
        'Shell internet access conflicts with the endowed name "shell"',
      );
    }
    objects = [
      ...objects,
      { kind: 'development-environment', petName: 'shell' },
    ];
  }
  return harden({ ...preset, objects, networkPolicy: policy });
};
harden(withSessionNetwork);

// Validate edits without preventing older, incompatible settings from being
// loaded and repaired. Runtime availability is still checked at creation.
const assertPresetDefaults = preset => {
  const fae = DEVELOPMENT_BACKENDS.includes(preset.backendId || 'provider');
  if (presetHasShell(preset) && !fae)
    throw Error(
      'An isolated shell requires a Fae model. Hosted backends own their environment.',
    );
  withSessionNetwork(preset, preset.networkPolicy);
};

/** One bounded record and a serialized, revision-checked write queue. */
export const makePresetCatalog = host => {
  let loaded;
  let loading;
  let tail = Promise.resolve();
  const load = () => {
    if (loaded) return Promise.resolve(loaded);
    if (!loading)
      loading = (async () => {
        if (!(await E(host).has(STORAGE_NAME))) return defaults;
        const value = await E(host).lookup(STORAGE_NAME);
        if (
          ![1, 2].includes(value?.version) ||
          typeof value.revision !== 'string' ||
          !Array.isArray(value.presets) ||
          Number(value.presets.length) >
            (value.version === 1 ? 64 : 58 + BUILTIN_PRESETS.length)
        )
          throw Error('Invalid stored preset settings');
        const legacy = value.version === 1;
        const presets = value.presets.map(preset => normalizePreset(preset));
        const builtinAliases = { ...(legacy ? {} : value.builtinAliases) };
        if (legacy) {
          // A previously saved custom name must never become a more privileged
          // template. Add the new built-in under a free ID in that catalog.
          for (const builtin of BUILTIN_PRESETS.filter(item =>
            protectedTemplates.includes(item.id),
          )) {
            const { id } = builtin;
            let actual = id;
            let suffix = 1;
            while (presets.some(item => item.id === actual)) {
              actual = `${id}-builtin-${suffix}`;
              suffix += 1;
            }
            if (actual !== id) builtinAliases[id] = actual;
            presets.push(harden({ ...builtin, id: actual }));
          }
        }
        if (
          Object.entries(builtinAliases).some(
            ([id, actual]) =>
              !protectedTemplates.includes(id) ||
              typeof actual !== 'string' ||
              !new RegExp(`^${id}-builtin-[1-9][0-9]*$`).test(actual),
          )
        )
          throw Error('Invalid built-in preset IDs');
        if (
          new Set(presets.map(preset => preset.id)).size !== presets.length ||
          !presets.some(preset => preset.id === value.voicePresetId) ||
          !BUILTIN_PRESETS.every(builtin =>
            presets.some(
              preset =>
                preset.id === (builtinAliases[builtin.id] ?? builtin.id) &&
                (!protectedTemplates.includes(builtin.id) ||
                  preset.templateId === builtin.id),
            ),
          )
        )
          throw Error('Invalid stored preset catalog');
        return harden({
          ...value,
          version: 2,
          builtinAliases,
          revision: legacy ? `v2:${value.revision}` : value.revision,
          presets,
        });
      })()
        .then(value => {
          loaded = value;
          return value;
        })
        .catch(error => {
          loading = undefined;
          throw error;
        });
    return loading;
  };
  const change = (revision, update) => {
    const result = tail.then(async () => {
      const current = await load();
      if (revision !== current.revision)
        throw Error('Preset settings changed elsewhere. Reload before saving.');
      const next = harden({
        ...update(current),
        version: 2,
        revision: randomUUID(),
      });
      if (Number(next.presets.length) > 58 + BUILTIN_PRESETS.length)
        throw Error('Too many assistant presets');
      try {
        await E(host).storeValue(next, STORAGE_NAME);
      } catch (error) {
        // The write may have committed before its acknowledgment was lost.
        // Re-read durable authority before serving or accepting another edit.
        loaded = undefined;
        loading = undefined;
        throw error;
      }
      loaded = next;
      return next;
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const get = async id => {
    const preset = (await load()).presets.find(item => item.id === id);
    if (!preset) throw Error(`Unknown preset: ${id}`);
    return preset;
  };
  return harden({
    read: async () => {
      const current = await load();
      return harden({
        ...current,
        templates,
        builtinIds: BUILTIN_PRESETS.map(p => builtinId(current, p.id)),
      });
    },
    offline: async () => get(builtinId(await load(), 'chat-only')),
    get,
    voice: async () => {
      const config = await load();
      return config.presets.find(item => item.id === config.voicePresetId);
    },
    save: (preset, revision) =>
      change(revision, current => {
        const protectedId = protectedTemplates.find(
          id => builtinId(current, id) === preset.id,
        );
        if (protectedId && preset.templateId !== protectedId)
          throw Error('This built-in preset cannot change its template');
        const next = normalizePreset(preset);
        assertPresetDefaults(next);
        return {
          ...current,
          presets: [
            ...current.presets.filter(item => item.id !== next.id),
            next,
          ],
        };
      }),
    remove: (id, revision) =>
      change(revision, current => {
        if (
          BUILTIN_PRESETS.some(preset => builtinId(current, preset.id) === id)
        )
          throw Error('Built-in presets can be reset, not deleted');
        if (current.voicePresetId === id)
          throw Error('Choose another voice preset before deleting this one');
        if (!current.presets.some(preset => preset.id === id))
          throw Error('Unknown preset');
        return {
          ...current,
          presets: current.presets.filter(preset => preset.id !== id),
        };
      }),
    reset: (id, revision) =>
      change(revision, current => {
        const builtin = BUILTIN_PRESETS.find(
          preset => builtinId(current, preset.id) === id,
        );
        if (!builtin) throw Error('Only built-in presets can be reset');
        return {
          ...current,
          presets: current.presets.map(preset =>
            preset.id === id ? harden({ ...builtin, id }) : preset,
          ),
        };
      }),
    selectVoice: (id, revision) =>
      change(revision, current => {
        const preset = current.presets.find(item => item.id === id);
        if (!preset) throw Error('Unknown voice preset');
        assertPresetDefaults(preset);
        return { ...current, voicePresetId: id };
      }),
    whenIdle: () => tail,
  });
};
harden(makePresetCatalog);

// @ts-check
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';

/**
 * Host-side preset editor. Capabilities stay here; the confined view receives
 * only names and source paths, never the endowed objects themselves.
 * @param {{factory: any, rootPowers: any, changed: () => void, catalogChanged: () => Promise<void>}} options
 */
export const makePresetSettings = ({
  factory,
  rootPowers,
  changed,
  catalogChanged,
}) => {
  /** @type {any} */
  let configuration;
  let busy = false;
  let error = '';
  let message = '';
  const read = async () => {
    configuration = await E(factory).getPresetConfiguration();
  };
  const run = async operation => {
    if (busy) return;
    busy = true;
    error = '';
    message = '';
    changed();
    try {
      await operation();
    } catch (reason) {
      error = /** @type {Error} */ (reason).message;
    } finally {
      busy = false;
      changed();
    }
  };
  const update = async operation => {
    if (!configuration) throw Error('Load preset settings first');
    await operation(configuration.revision);
    await read();
    await catalogChanged();
    message = 'Saved. Applies to new sessions.';
  };
  return harden({
    getState: () => ({
      busy,
      error,
      message,
      configuration: configuration
        ? {
            revision: configuration.revision,
            voicePresetId: configuration.voicePresetId,
            builtinIds: configuration.builtinIds,
            templates: configuration.templates,
            presets: configuration.presets.map(({ endowments, ...preset }) => ({
              ...preset,
              endowments: endowments.map(({ petName, sourcePath }, index) => ({
                retainedId: `${configuration.revision}:${preset.id}:${index}`,
                petName,
                sourcePath,
              })),
            })),
          }
        : null,
    }),
    load: () =>
      run(async () => {
        await read();
        await catalogChanged();
      }),
    save: draft =>
      run(() =>
        update(async revision => {
          const endowments = await Promise.all(
            draft.endowments.map(async item => {
              const retained = configuration.presets
                .flatMap(preset =>
                  preset.endowments.map((existing, index) => ({
                    ...existing,
                    retainedId: `${configuration.revision}:${preset.id}:${index}`,
                  })),
                )
                .find(
                  existing =>
                    existing.retainedId === item.retainedId &&
                    JSON.stringify(existing.sourcePath) ===
                      JSON.stringify(item.sourcePath),
                );
              if (item.retainedId && !retained)
                throw Error(
                  'Retained object changed. Reload presets before saving.',
                );
              if (retained)
                return {
                  petName: item.petName,
                  sourcePath: retained.sourcePath,
                  value: retained.value,
                };
              if (
                !Array.isArray(item.sourcePath) ||
                !item.sourcePath.length ||
                item.sourcePath.some(part => !part)
              )
                throw Error('Enter an object path for each endowment');
              const value = await E(rootPowers).lookup(...item.sourcePath);
              return {
                petName: item.petName,
                sourcePath: item.sourcePath,
                value,
              };
            }),
          );
          await E(factory).savePreset(
            harden({ ...draft, endowments }),
            revision,
          );
        }),
      ),
    remove: id =>
      run(() => update(revision => E(factory).deletePreset(id, revision))),
    reset: id =>
      run(() => update(revision => E(factory).resetPreset(id, revision))),
    selectVoice: id =>
      run(() => update(revision => E(factory).setVoicePreset(id, revision))),
  });
};
harden(makePresetSettings);

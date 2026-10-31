// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

/** @param {any} audit */
export const make = async audit => {
  const before = await E(audit).maybeReadText('runner-revivals');
  await E(audit).writeText('runner-revivals', `${BigInt(before || '0') + 1n}`);
  return Far('EnvironmentRunnerFixture', {
    provideEnvironment: async (_id, _recipe, dependencies) =>
      Far('InertEnvironmentFixture', {
        open: async () => {
          const workspace = await E(dependencies).get('workspace');
          return Far('EnvironmentNativeShellFixture', {
            exec: async () =>
              harden({
                stdout: await E(workspace).ping(),
                stderr: '',
                exitCode: 0,
                signal: null,
                truncated: false,
              }),
          });
        },
        stop: async () => {},
      }),
    removeEnvironmentStorage: async () => {},
  });
};
harden(make);

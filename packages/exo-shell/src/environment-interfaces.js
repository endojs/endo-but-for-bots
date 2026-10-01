// @ts-check
import { Fail } from '@endo/errors';
import { M, mustMatch } from '@endo/patterns';

export const EnvironmentRecipeShape = harden({
  policy: {
    allowedCommands: M.arrayOf(M.string()),
    timeoutMs: M.number(),
    maxOutputBytes: M.number(),
  },
  networkPolicy: M.or('off', 'public-internet'),
});
harden(EnvironmentRecipeShape);

/** @param {any} recipe */
export const assertEnvironmentRecipe = recipe => {
  mustMatch(recipe, EnvironmentRecipeShape);
  const { policy } = recipe;
  (policy.allowedCommands.length > 0 &&
    policy.allowedCommands.every(command =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(command),
    ) &&
    Number.isInteger(policy.timeoutMs) &&
    policy.timeoutMs > 0 &&
    policy.timeoutMs <= 0x7fff_ffff &&
    Number.isInteger(policy.maxOutputBytes) &&
    policy.maxOutputBytes > 0 &&
    policy.maxOutputBytes <= 0xffff_ffff) ||
    Fail`Invalid environment execution bounds`;
};
harden(assertEnvironmentRecipe);

// The private runner gives an inert controller, never starts native work on a
// request whose reply could be lost. Only open admits effects. Stop must reach
// pending open/commands outside their queue and acknowledge original cleanup.
export const EnvironmentRunnerInterface = M.interface('EnvironmentRunner', {
  provideEnvironment: M.callWhen(
    M.string(),
    EnvironmentRecipeShape,
    M.remotable(),
  ).returns(M.remotable()),
  removeEnvironmentStorage: M.callWhen(M.string()).returns(M.undefined()),
});
harden(EnvironmentRunnerInterface);
export const EnvironmentControllerInterface = M.interface(
  'EnvironmentController',
  {
    open: M.callWhen().returns(M.remotable()),
    stop: M.callWhen().returns(M.undefined()),
  },
);
harden(EnvironmentControllerInterface);

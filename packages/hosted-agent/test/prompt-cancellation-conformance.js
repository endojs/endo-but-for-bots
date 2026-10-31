// @ts-check

/**
 * Behavioral admission contract shared by native client fixtures. Each fixture
 * owns its protocol gate and cleanup. Cancellation need not finish until the
 * gate releases; a successor may run or the incarnation may explicitly refuse
 * it. Neither outcome permits the canceled prompt to reach native execution.
 * This helper deliberately does not interpret CLI events or claim process exit.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ start: () => Promise<void>, cancel: () => Promise<void>,
 * whileHeld: () => Promise<void>, release: () => void,
 * settle: () => Promise<void>, admitted: () => string[],
 * expected: string[] }} fixture
 */
export const exercisePromptCancellation = async (t, fixture) => {
  t.timeout(5000);
  await fixture.start();
  t.deepEqual(fixture.admitted(), [], 'preparation has not admitted a prompt');
  await fixture.cancel();
  await fixture.whileHeld();
  t.deepEqual(
    fixture.admitted(),
    [],
    'cancellation keeps prompt admission fenced',
  );
  fixture.release();
  await fixture.settle();
  t.deepEqual(
    fixture.admitted(),
    fixture.expected,
    'only the permitted successor may execute',
  );
};
harden(exercisePromptCancellation);

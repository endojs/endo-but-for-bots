// @ts-check

/**
 * A confirmed, non-poisoning turn failure settles once and does not replay.
 * Fixtures retain ownership of protocol events and context restoration: an
 * abort alone does not prove native quiescence or authorize a successor.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ fail: () => Promise<any[]>, succeed: () => Promise<any[]>,
 * admitted: () => string[] }} fixture
 */
export const exerciseFailedTurnSuccessor = async (t, fixture) => {
  t.timeout(5000);
  const failed = await fixture.fail();
  t.is(failed.at(-1)?.type, 'abort');
  t.is(failed.filter(event => ['abort', 'end'].includes(event.type)).length, 1);
  t.deepEqual(fixture.admitted(), ['first']);
  const successor = await fixture.succeed();
  t.is(successor.at(-1)?.type, 'end', successor.at(-1)?.reason);
  t.is(
    successor.filter(event => ['abort', 'end'].includes(event.type)).length,
    1,
  );
  t.deepEqual(fixture.admitted(), ['first', 'second'], 'no automatic replay');
};
harden(exerciseFailedTurnSuccessor);

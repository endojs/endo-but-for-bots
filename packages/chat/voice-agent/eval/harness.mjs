// harness.mjs — run one obstacle's grade() `repeats` times → a cell. Repeats capture
// variance (deterministic obstacles are stable; LLM-graded ones won't be). A cell is the
// (obstacle, arch, model) result the tree + aggregate consume.
export const runObstacle = async (mod, { arch, model, repeats = 1, config = null }) => {
  const id = (mod.meta && mod.meta.id) || 'obstacle';
  let passes = 0;
  let lastDetail = null;
  const t0 = Date.now();
  for (let i = 0; i < repeats; i += 1) {
    let res;
    // grade() receives the arch config too (Task 3 / §6a): config-aware obstacles can grade the
    // orchestration shape itself; config-insensitive obstacles (e.g. 07) simply ignore it.
    try { res = await mod.grade({ model, config }); }
    catch (e) { res = { passed: false, error: e && e.message, checks: [] }; }
    if (res && res.passed) passes += 1;
    lastDetail = res;
  }
  const wallMs = Date.now() - t0;
  return {
    obstacle: id,
    arch,
    model,
    repeats,
    passes,
    passRate: repeats ? passes / repeats : 0,
    passed: passes === repeats && repeats > 0,
    wallMs,
    detail: lastDetail,
  };
};

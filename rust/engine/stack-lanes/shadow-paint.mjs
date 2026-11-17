// Shadow-stack painting (STACK-DEPTH-REFACTOR.md §5 lane A), shared by the
// Node runner (node/run.cjs, which imports it) and the workerd Worker
// (workerd/worker.js, whose config embeds it beside the worker), so both
// hosts' marks come from one scan.
//
// The module links its shadow stack first in linear memory, so the region
// below the initial __stack_pointer is the shadow stack. Fill it with a
// sentinel before the run and find the lowest byte the run dirtied
// afterwards; the difference from the initial pointer is the shadow stack's
// high-water mark in bytes.
export const SENTINEL = 0xa5;
export const PAINT_MARGIN = 1024; // leave the lowest addresses alone

// Paint below the instance's initial __stack_pointer; null when the module
// exports no __stack_pointer or memory to paint.
export function paint(instance) {
  const sp = instance.exports.__stack_pointer;
  const memory = instance.exports.memory;
  if (!sp || !memory) return null;
  const top = sp.value;
  new Uint8Array(memory.buffer, PAINT_MARGIN, top - PAINT_MARGIN).fill(SENTINEL);
  return { top };
}

// The painted region's high-water mark in bytes below its top.
export function highWater(instance, painted) {
  const bytes = new Uint8Array(instance.exports.memory.buffer, 0, painted.top);
  for (let addr = PAINT_MARGIN; addr < painted.top; addr++) {
    if (bytes[addr] !== SENTINEL) return painted.top - addr;
  }
  return 0;
}

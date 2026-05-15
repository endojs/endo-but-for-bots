// @ts-check

import '@endo/init/debug.js';

import fs from 'node:fs/promises';

import test from 'ava';

const capabilityTools = new Set(['timestampTool', 'mathTool', 'readFile']);

test('capability examples accept both direct tool calls and exec composition', async t => {
  const examples = JSON.parse(
    await fs.readFile(new URL('../optimizer/examples.json', import.meta.url)),
  );

  for (const example of examples) {
    const hasDirectCapabilityTrace = example.acceptableTraces.some(trace =>
      trace.some(step => capabilityTools.has(step.tool)),
    );
    if (hasDirectCapabilityTrace) {
      const hasExecTrace = example.acceptableTraces.some(trace =>
        trace.some(step => step.tool === 'exec'),
      );
      t.true(
        hasExecTrace,
        `${example.id} should accept exec composition as well as direct tool calls`,
      );
    }
  }
});

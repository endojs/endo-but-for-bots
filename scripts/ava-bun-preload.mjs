import childProcess from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import v8 from 'node:v8';

// AVA flushes V8 coverage after every run. Bun does not implement this API,
// even when coverage collection is not enabled.
v8.takeCoverage = () => {};

// The shared AVA configurations select export conditions with Node's `-C`
// short flag, which Bun rejects. Bun accepts the long `--conditions` form.
const translateExecArgv = execArgv => {
  const translated = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (argument === '-C' && index + 1 < execArgv.length) {
      index += 1;
      translated.push(`--conditions=${execArgv[index]}`);
    } else {
      translated.push(argument);
    }
  }
  return translated;
};

const { fork } = childProcess;
childProcess.fork = (modulePath, argumentList, options) => {
  if (options?.execArgv) {
    return fork(modulePath, argumentList, {
      ...options,
      execArgv: translateExecArgv(options.execArgv),
    });
  }
  return fork(modulePath, argumentList, options);
};

// AVA's error serializer assumes every parsed stack frame names a file.
// JavaScriptCore reports frames such as `at processTicksAndRejections (native)`
// without one, and the resulting internal error hides the test's own failure.
const requireFromAva = createRequire(
  realpathSync(
    new URL('../node_modules/ava/lib/serialize-error.js', import.meta.url),
  ),
);
const StackUtils = requireFromAva('stack-utils');
const { parseLine } = StackUtils.prototype;
StackUtils.prototype.parseLine = function parseLineWithFile(line) {
  const callSite = Reflect.apply(parseLine, this, [line]);
  return callSite?.file === undefined ? null : callSite;
};

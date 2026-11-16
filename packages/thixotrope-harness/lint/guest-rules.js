// @ts-check
/**
 * Lint rules for confined guest code (architecture.md section 12): modules
 * under `guest/` run in Ironhorse vats, which have no clock, randomness,
 * timers or console, and whose bundles must not carry second copies of the
 * `@endo/*` libraries the Thixotrope prelude already provides.
 *
 * The root `eslint.config.js` spreads `harnessLintConfigs` at its end; the
 * unit test applies `guestRules` alone with ESLint's `Linter`.
 */

/** @import { Linter, Rule, Scope } from 'eslint' */

const HARNESS = 'packages/thixotrope-harness';

/** Ambient authority a vat does not have, or that guest code must not use. */
export const forbiddenGuestGlobals = Object.freeze([
  'Date',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'console',
  'WeakRef',
  'FinalizationRegistry',
  'performance',
  'fetch',
  'crypto',
  'process',
  'require',
  'Buffer',
  'URL',
]);

/** The names `pkg/src/guest/prelude.js` installs as vat globals. */
export const preludeGlobals = Object.freeze([
  'E',
  'Far',
  'harden',
  'makeExo',
  'defineExoClass',
  'defineExoClassKit',
  'M',
  'matches',
  'mustMatch',
  'passStyleOf',
  'Fail',
  'q',
  'makeError',
  'makePromiseKit',
  'makeSerialQueue',
  'describeError',
  'isRemotable',
  'HEX128_PATTERN',
  'assertWorkspaceName',
  'assertInstallationName',
]);

const forbiddenNamePattern = `/^(${forbiddenGuestGlobals.join('|')})$/`;

const LOOPS = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);
// A callback passed to one of these runs once per element: a loop body.
const ITERATION_METHODS = new Set([
  'forEach',
  'map',
  'flatMap',
  'reduce',
  'reduceRight',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
]);
const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);
// Methods whose result is a string (or almost always used as one).
const STRING_METHODS = new Set([
  'charAt',
  'slice',
  'substring',
  'substr',
  'toString',
  'padStart',
  'padEnd',
  'repeat',
  'join',
  'trim',
  'trimStart',
  'trimEnd',
  'toUpperCase',
  'toLowerCase',
  'replace',
  'replaceAll',
  'toFixed',
  'normalize',
  'fromCharCode',
  'fromCodePoint',
  'stringify',
]);

/**
 * Whether an expression is evidently a string. A static guess: it never
 * claims a number, and misses strings it cannot see (see the rule's note).
 * @param {any} node
 * @returns {boolean}
 */
const isStringish = node => {
  if (!node) return false;
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string';
    case 'TemplateLiteral':
      return true;
    case 'BinaryExpression':
      return (
        node.operator === '+' &&
        (isStringish(node.left) || isStringish(node.right))
      );
    case 'CallExpression': {
      const { callee } = node;
      if (callee.type === 'Identifier') return callee.name === 'String';
      return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        STRING_METHODS.has(callee.property.name)
      );
    }
    default:
      return false;
  }
};

/**
 * Whether `node` runs once per iteration: inside a loop body, or inside a
 * callback given to an array iteration method, without crossing another
 * function boundary first.
 * @param {Rule.RuleContext} context
 * @param {any} node
 */
const inLoop = (context, node) => {
  /** @type {any[]} */
  const ancestors = context.sourceCode.getAncestors(node);
  let child = node;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i];
    if (LOOPS.has(ancestor.type)) {
      // The `for (init; test; update)` header runs per iteration too, but a
      // counter there is never a string; only the body matters.
      if (ancestor.body === child) return true;
    } else if (FUNCTIONS.has(ancestor.type)) {
      const parent = ancestors[i - 1];
      return (
        parent?.type === 'CallExpression' &&
        parent.arguments.includes(ancestor) &&
        parent.callee.type === 'MemberExpression' &&
        !parent.callee.computed &&
        ITERATION_METHODS.has(parent.callee.property.name)
      );
    }
    child = ancestor;
  }
  return false;
};

/**
 * Whether the identifier names a variable initialised with a string.
 * @param {Rule.RuleContext} context
 * @param {any} identifier
 */
const isStringVariable = (context, identifier) => {
  /** @type {Scope.Scope | null} */
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      return variable.defs.some(
        def =>
          def.node.type === 'VariableDeclarator' &&
          def.node.id === def.name &&
          isStringish(def.node.init),
      );
    }
    scope = scope.upper;
  }
  return false;
};

/** @type {Rule.RuleModule} */
const noStringConcatInLoop = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid growing a string with += (or s = s + x) inside a loop in guest code: without GC inside a crank the cost is quadratic in heap and can quarantine the vat. Push parts to an array and join.',
    },
    schema: [],
    messages: {
      concat:
        'Do not grow a string inside a loop in guest code; push parts to an array and join them (architecture section 12, rule 2).',
    },
  },
  create: context => {
    /**
     * @param {any} target
     * @param {any} value
     */
    const isStringGrowth = (target, value) =>
      isStringish(value) ||
      (target.type === 'Identifier' && isStringVariable(context, target));
    return {
      /** @param {any} node */
      AssignmentExpression: node => {
        if (node.operator === '+=') {
          if (isStringGrowth(node.left, node.right) && inLoop(context, node))
            context.report({ node, messageId: 'concat' });
          return;
        }
        if (node.operator !== '=' || node.left.type !== 'Identifier') return;
        const { left, right } = node;
        /** @param {any} n */
        const isTarget = n => n.type === 'Identifier' && n.name === left.name;
        // s = s + x and s = x + s (prepend).
        const plusGrowth =
          right.type === 'BinaryExpression' &&
          right.operator === '+' &&
          ((isTarget(right.left) && isStringGrowth(left, right.right)) ||
            (isTarget(right.right) && isStringGrowth(left, right.left)));
        // s = s.concat(x): concat is a string method only on a string, so
        // the target must be known to be one.
        const concatGrowth =
          right.type === 'CallExpression' &&
          right.callee.type === 'MemberExpression' &&
          !right.callee.computed &&
          right.callee.property.name === 'concat' &&
          isTarget(right.callee.object) &&
          isStringVariable(context, left);
        if ((plusGrowth || concatGrowth) && inLoop(context, node))
          context.report({ node, messageId: 'concat' });
      },
    };
  },
};

export const guestLintPlugin = Object.freeze({
  meta: { name: 'thixotrope-harness-guest', version: '0.1.0' },
  rules: { 'no-string-concat-in-loop': noStringConcatInLoop },
});

/**
 * The rules alone, without file globs, for applying to any file.
 * @type {Linter.Config}
 */
export const guestRules = {
  plugins: { 'thixotrope-harness-guest': guestLintPlugin },
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    globals: Object.fromEntries(
      preludeGlobals.map(name => [name, /** @type {const} */ ('readonly')]),
    ),
  },
  rules: {
    'thixotrope-harness-guest/no-string-concat-in-loop': 'error',
    'no-restricted-globals': [
      'error',
      ...forbiddenGuestGlobals.map(name => ({
        name,
        message: `Vats have no ambient ${name}; time, ids and randomness arrive as data or through adapters (architecture section 8).`,
      })),
    ],
    'no-restricted-properties': [
      'error',
      {
        object: 'Math',
        property: 'random',
        message: 'Vats have no randomness; ids are counters (section 8).',
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ImportExpression',
        message: 'Guest code cannot import dynamically.',
      },
      {
        selector:
          "Identifier[name='Math']:not(MemberExpression[computed=false] > Identifier.object)",
        message: 'Use named Math methods; do not alias Math.',
      },
      {
        selector: `MemberExpression[object.name='globalThis'][property.name=${forbiddenNamePattern}]`,
        message:
          'Vats have no clock, timers, console or weak references; do not reach for them through globalThis.',
      },
      {
        selector: `VariableDeclarator[init.name='globalThis'] > ObjectPattern > Property[key.name=${forbiddenNamePattern}]`,
        message:
          'Vats have no clock, timers, console or weak references; do not destructure them from globalThis.',
      },
      // The forms above name globalThis's property literally; these close
      // the routes that hide the name (QC advisory 6).
      {
        selector: "MemberExpression[object.name='globalThis'][computed=true]",
        message:
          'Read prelude names from globalThis by name (globalThis.E or const { E } = globalThis), not by a computed key.',
      },
      {
        selector:
          "VariableDeclarator[init.name='globalThis'][id.type!='ObjectPattern'], AssignmentExpression[right.name='globalThis'], CallExpression > Identifier.arguments[name='globalThis'], NewExpression > Identifier.arguments[name='globalThis'], SpreadElement > Identifier.argument[name='globalThis']",
        message:
          'Do not alias or pass globalThis; destructure the prelude names you need (const { E } = globalThis).',
      },
      {
        selector: `AssignmentExpression[right.name='globalThis'] > ObjectPattern > Property[key.name=${forbiddenNamePattern}]`,
        message:
          'Vats have no clock, timers, console or weak references; do not destructure them from globalThis.',
      },
      {
        selector: "Identifier[name='eval']",
        message:
          'Guest code does not evaluate strings; code arrives as a bundle (direct or indirect eval).',
      },
      {
        selector:
          "NewExpression[callee.name='Function'], CallExpression[callee.name='Function']",
        message:
          'Guest code does not evaluate strings; do not construct a Function from source.',
      },
    ],
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: '^(?!\\.{1,2}/)',
            message:
              'Guest modules import only relative modules: read E, Far, M, makeExo and the rest of the prelude from globalThis, and copy pure Endo modules into guest/lib/ (architecture section 1).',
          },
        ],
      },
    ],
  },
};

/**
 * Configs for the root flat config: the harness's own ignores, Node globals
 * for scripts and perf, and the guest rules for `guest/` and guest fixtures.
 * The root passes its Node globals so this module needs no dependency of its
 * own on the `globals` package.
 * @param {object} options
 * @param {Record<string, 'readonly' | 'writable' | boolean>} options.nodeGlobals
 * @returns {Linter.Config[]}
 */
export const makeHarnessLintConfigs = ({ nodeGlobals }) => [
  {
    ignores: [
      `${HARNESS}/tmp/`,
      `${HARNESS}/dist-guest/`,
      // Survey reference scripts, kept as written; they import by paths
      // relative to packages/thixotrope and do not run from here.
      `${HARNESS}/designs/`,
    ],
  },
  {
    files: [`${HARNESS}/perf/**`, `${HARNESS}/scripts/**`],
    languageOptions: { globals: nodeGlobals },
    rules: {
      'no-await-in-loop': 'off',
      '@jessie.js/safe-await-separator': 'off',
    },
  },
  {
    files: [
      `${HARNESS}/guest/**/*.js`,
      `${HARNESS}/test/fixtures/guest/**/*.js`,
    ],
    ...guestRules,
  },
];

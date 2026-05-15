const { RuleTester } = require('eslint');
const rule = require('../lib/rules/harden-exports');

const jsValid = [
  {
    code: `
export const a = 1;
harden(a);
export const b = 2;
harden(b);
              `,
  },
  {
    code: `
export const a = 1;
harden(a);
export const b = 2;
harden(b);
              `,
  },
  {
    code: `
export const {
  getEnvironmentOption,
  getEnvironmentOptionsList,
  environmentOptionsListHas,
  } = makeEnvironmentCaptor();
harden(getEnvironmentOption);
harden(getEnvironmentOptionsList);
harden(environmentOptionsListHas);
        `,
  },
  {
    code: `
export const { propName: exportName } = objWithPropName;
harden(exportName);
    `,
  },
  {
    code: `
export const [ item1, item2 ] = [fn1, fn2];
harden(item1);
harden(item2);
    `,
  },
  {
    code: `
export const { wrapper: { propName } } = objWithWrapper;
harden(propName);
    `,
  },
  {
    code: `
export const { wrapper: { propName: exportName } } = objWithWrapper;
harden(exportName);
    `,
  },
  {
    code: `
export const [{ wrapper: { propName: exportName } }] = [objWithWrapper];
harden(exportName);
    `,
  },
  {
    code: `
export const [[deepItem]] = [[fn]];
harden(deepItem);
    `,
  },
  {
    code: `
export const { wrapper: { propName = defaultValue } } = objWithWrapper;
harden(propName);
    `,
  },
  {
    // RestElement in an ObjectPattern is silently skipped (with a console.warn);
    // the non-rest binding is the only one the rule expects a harden call for.
    // ObjectPattern rest needs ecmaVersion >= 2018.
    code: `
export const { a, ...rest } = obj;
harden(a);
    `,
    parserOptions: { ecmaVersion: 2018, sourceType: 'module' },
  },
  {
    // RestElement in an ArrayPattern is silently skipped (with a console.warn);
    // the non-rest binding is the only one the rule expects a harden call for.
    code: `
export const [first, ...rest] = arr;
harden(first);
    `,
  },
  {
    // Specifier-form export (`export { x }`) with a matching harden call.
    code: `
const x = 1;
harden(x);
export { x };
    `,
  },
  {
    // Aliased specifier-form export; the rule keys on the exported (aliased) name.
    code: `
const local = 1;
harden(renamed);
export { local as renamed };
    `,
  },
];

const invalid = [
  {
    code: `
export const a = 'alreadyHardened';
export const b = 'toHarden';

harden(a);
              `,
    errors: [
      {
        message: "Named export 'b' should be followed by a call to 'harden'.",
      },
    ],
    output: `
export const a = 'alreadyHardened';
export const b = 'toHarden';
harden(b);

harden(a);
              `,
  },
  {
    code: `
export const a = 1;
              `,
    errors: [
      {
        message: "Named export 'a' should be followed by a call to 'harden'.",
      },
    ],
    output: `
export const a = 1;
harden(a);
              `,
  },
  {
    code: `
export function foo() {
      console.log("foo");
  }
              `,
    errors: [
      {
        message:
          "Export 'foo' should be a const declaration with an arrow function.",
      },
    ],
    output: `
export function foo() {
      console.log("foo");
  }
              `,
  },
  {
    code: `
export function
  multilineFunction() {
      console.log("This is a multiline function.");
  }
              `,
    errors: [
      {
        message:
          "Export 'multilineFunction' should be a const declaration with an arrow function.",
      },
    ],
    output: `
export function
  multilineFunction() {
      console.log("This is a multiline function.");
  }
              `,
  },
  {
    code: `
export const a = 1;
export const b = 2;

export const alreadyHardened = 3;
harden(alreadyHardened);

export function foo() {
  console.log("foo");
  }
export function
  multilineFunction() {
  console.log("This is a multiline function.");
  }
        `,
    errors: [
      {
        message: "Named export 'a' should be followed by a call to 'harden'.",
      },
      {
        message: "Named export 'b' should be followed by a call to 'harden'.",
      },
      {
        message:
          "Export 'foo' should be a const declaration with an arrow function.",
      },
      {
        message:
          "Export 'multilineFunction' should be a const declaration with an arrow function.",
      },
    ],
    output: `
export const a = 1;
harden(a);
export const b = 2;
harden(b);

export const alreadyHardened = 3;
harden(alreadyHardened);

export function foo() {
  console.log("foo");
  }
export function
  multilineFunction() {
  console.log("This is a multiline function.");
  }
        `,
  },
  {
    code: `
export const {
getEnvironmentOption,
getEnvironmentOptionsList,
environmentOptionsListHas,
} = makeEnvironmentCaptor();
    `,
    errors: [
      {
        message:
          "Named exports 'getEnvironmentOption, getEnvironmentOptionsList, environmentOptionsListHas' should be followed by a call to 'harden'.",
      },
    ],
    output: `
export const {
getEnvironmentOption,
getEnvironmentOptionsList,
environmentOptionsListHas,
} = makeEnvironmentCaptor();
harden(getEnvironmentOption);
harden(getEnvironmentOptionsList);
harden(environmentOptionsListHas);
    `,
  },
  {
    code: `
export const { propName: exportName } = objWithPropName;
    `,
    errors: [
      {
        message:
          "Named export 'exportName' should be followed by a call to 'harden'.",
      },
    ],
    output: `
export const { propName: exportName } = objWithPropName;
harden(exportName);
    `,
  },
  {
    code: `
export const [ item1, item2 ] = [fn1, fn2];
harden(item1);
    `,
    errors: [
      {
        message:
          "Named export 'item2' should be followed by a call to 'harden'.",
      },
    ],
    output: `
export const [ item1, item2 ] = [fn1, fn2];
harden(item2);
harden(item1);
    `,
  },
  {
    code: `
export const { wrapper: { propName } } = objWithWrapper;
    `,
    errors: [
      {
        message:
          "Named export 'propName' should be followed by a call to 'harden'.",
      },
    ],
    output: `
export const { wrapper: { propName } } = objWithWrapper;
harden(propName);
    `,
  },
  {
    code: `
export const [{ wrapper: { propName: exportName } }] = [objWithWrapper];
    `,
    errors: [
      {
        message:
          "Named export 'exportName' should be followed by a call to 'harden'.",
      },
    ],
    output: `
export const [{ wrapper: { propName: exportName } }] = [objWithWrapper];
harden(exportName);
    `,
  },
  {
    // Specifier-form export missing a harden call.
    code: `
const x = 1;
export { x };
    `,
    errors: [
      {
        message: "Named export 'x' should be followed by a call to 'harden'.",
      },
    ],
    output: `
const x = 1;
export { x };
harden(x);
    `,
  },
  {
    // Aliased specifier-form export missing a harden call; the rule reports
    // the aliased (exported) name, and the autofix inserts a harden of that
    // exported name (which need not match a local binding).
    code: `
const local = 1;
export { local as renamed };
    `,
    errors: [
      {
        message:
          "Named export 'renamed' should be followed by a call to 'harden'.",
      },
    ],
    output: `
const local = 1;
export { local as renamed };
harden(renamed);
    `,
  },
];

const jsTester = new RuleTester({
  parserOptions: { ecmaVersion: 2015, sourceType: 'module' },
});
jsTester.run('harden JS exports', rule, {
  valid: jsValid,
  invalid,
});

const tsTester = new RuleTester({
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 2015, sourceType: 'module' },
});
tsTester.run('harden TS exports', rule, {
  valid: [
    ...jsValid,
    {
      // harden() on only value exports
      code: `
export type Foo = string;
export interface Bar {
    baz: number;
}
          `,
    },
  ],
  invalid,
});
